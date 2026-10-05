/* eslint-disable */
/**
 * OpenCV worker — งานภาพหนัก ๆ ทั้งหมดทำที่นี่ เพื่อไม่ให้ UI ค้าง
 *   detect : หาขอบเอกสาร (เทา → Gaussian blur → Canny → contour → สี่เหลี่ยมใหญ่สุด)
 *   warp   : ปรับมุมมองให้แบนเหมือนสแกน (perspective transform)
 *   filter : ฟิลเตอร์เอกสาร (ลบเงา/ปรับพื้นกระดาษให้ขาว โดยไม่ทำลายลายเซ็น/ตราประทับ)
 *   adjust : ความสว่าง / คอนทราสต์ / ความอิ่มสี / ความคม
 * รูปเข้า-ออกเป็น ImageData (โอน buffer ไม่ copy) — ไม่มีการส่งรูปออกนอกเครื่อง
 */
var ready = false, queue = [];
function whenReady(fn) { ready ? fn() : queue.push(fn); }
function markReady(mod) {
  if (ready) return;
  if (mod && mod.Mat) self.cv = mod;
  ready = true;
  queue.splice(0).forEach(function (f) { f(); });
}
/*
 * โหลด OpenCV (@techstark/opencv-js 4.10 แบบ MODULARIZE)
 * ทดสอบแล้ว: cv หลัง importScripts เป็น thenable ที่ resolve เป็นโมดูลจริง (มี cv.Mat)
 * ส่วน Module.onRuntimeInitialized ที่ตั้งไว้ล่วงหน้า "ไม่ถูกเรียก" ใน build นี้
 * จึงรอผ่าน cv.then(callback) — ห้าม await/Promise.resolve(cv) เพราะ thenable ที่ resolve
 * เป็นตัวเองจะวนไม่จบ • มีตัวสำรองเช็ก cv.Mat เป็นระยะ เผื่อ build อื่นพร้อมใช้ทันที
 */
importScripts('/vendor/opencv.js');
(function wait(tries) {
  if (typeof cv === 'undefined') { if (tries < 400) setTimeout(function () { wait(tries + 1); }, 50); return; }
  if (cv.Mat) { markReady(cv); return; }
  if (tries === 0 && typeof cv.then === 'function') {
    try { cv.then(function (m) { markReady(m && m.Mat ? m : cv); }); } catch (e) { /* ใช้ตัวสำรองด้านล่าง */ }
  }
  if (tries < 600) setTimeout(function () { if (!ready) wait(tries + 1); }, 50);
})(0);

function matFromImageData(d) { var m = cv.matFromImageData(d); return m; }
function toImageData(mat) {
  var rgba = new cv.Mat();
  if (mat.type() === cv.CV_8UC1) cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
  else if (mat.type() === cv.CV_8UC3) cv.cvtColor(mat, rgba, cv.COLOR_RGB2RGBA);
  else mat.copyTo(rgba);
  var out = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
  rgba.delete();
  return out;
}
function del() { for (var i = 0; i < arguments.length; i++) { var m = arguments[i]; if (m && !m.isDeleted()) m.delete(); } }

/** เรียงมุม บนซ้าย/บนขวา/ล่างขวา/ล่างซ้าย ด้วยผลบวก/ผลต่างของพิกัด */
function orderQuad(pts) {
  var bySum = pts.slice().sort(function (a, b) { return (a.x + a.y) - (b.x + b.y); });
  var byDiff = pts.slice().sort(function (a, b) { return (a.y - a.x) - (b.y - b.x); });
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}

/** หาสี่เหลี่ยมนูนที่ใหญ่สุดจากภาพขอบ */
function largestQuad(edges, minArea) {
  var contours = new cv.MatVector(), hier = new cv.Mat();
  cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  var best = null, bestArea = minArea;
  for (var i = 0; i < contours.size(); i++) {
    var c = contours.get(i);
    var area = cv.contourArea(c);
    if (area > bestArea) {
      var peri = cv.arcLength(c, true), approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * peri, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        var pts = [];
        for (var k = 0; k < 4; k++) pts.push({ x: approx.data32S[k * 2], y: approx.data32S[k * 2 + 1] });
        best = pts; bestArea = area;
      }
      approx.delete();
    }
    c.delete();
  }
  del(contours, hier);
  return best ? { pts: best, area: bestArea } : null;
}

function detect(d) {
  var src = matFromImageData(d), gray = new cv.Mat(), blur = new cv.Mat(), edges = new cv.Mat(), k = null;
  try {
    var total = d.width * d.height, minArea = total * 0.12;
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.Canny(blur, edges, 50, 150);
    k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.dilate(edges, edges, k);
    var found = largestQuad(edges, minArea);
    if (!found) {
      // ลองอีกแบบ: เอกสารสีขาวบนพื้นเข้ม — threshold แบบ Otsu แล้วปิดรู
      cv.threshold(blur, edges, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, k);
      found = largestQuad(edges, minArea);
    }
    if (!found) return { quad: null, confidence: 0 };
    return { quad: orderQuad(found.pts), confidence: Math.min(1, found.area / total) };
  } finally { del(src, gray, blur, edges, k); }
}

function warp(d, q) {
  var src = matFromImageData(d), dst = new cv.Mat();
  var dist = function (a, b) { return Math.hypot(a.x - b.x, a.y - b.y); };
  var w = Math.round(Math.max(dist(q[0], q[1]), dist(q[3], q[2])));
  var h = Math.round(Math.max(dist(q[0], q[3]), dist(q[1], q[2])));
  var from = cv.matFromArray(4, 1, cv.CV_32FC2, [q[0].x, q[0].y, q[1].x, q[1].y, q[2].x, q[2].y, q[3].x, q[3].y]);
  var to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
  var M = cv.getPerspectiveTransform(from, to);
  try {
    cv.warpPerspective(src, dst, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    return toImageData(dst);
  } finally { del(src, dst, from, to, M); }
}

/**
 * ลบเงา/แสงไม่สม่ำเสมอ: ประมาณพื้นกระดาษด้วย dilate + median blur แล้วหารออกทีละช่องสี
 * ตัวหนังสือ ลายเซ็น และตราประทับ (สีเข้มกว่าพื้น) ยังอยู่ครบ — ไม่ใช่ threshold ทิ้งสี
 */
function normalizeBackground(rgb) {
  var channels = new cv.MatVector(), outCh = new cv.MatVector();
  cv.split(rgb, channels);
  var k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  var size = Math.max(21, (Math.round(Math.max(rgb.cols, rgb.rows) / 60) | 1));
  for (var i = 0; i < 3; i++) {
    var ch = channels.get(i), bg = new cv.Mat(), diff = new cv.Mat(), norm = new cv.Mat();
    cv.dilate(ch, bg, k);
    cv.medianBlur(bg, bg, size % 2 ? size : size + 1);
    cv.absdiff(ch, bg, diff);
    cv.bitwise_not(diff, diff);
    cv.normalize(diff, norm, 0, 255, cv.NORM_MINMAX, cv.CV_8U);
    outCh.push_back(norm);
    del(ch, bg, diff, norm);
  }
  var out = new cv.Mat();
  cv.merge(outCh, out);
  del(channels, outCh, k);
  return out;
}
function sharpen(mat, amount) {
  var blur = new cv.Mat();
  cv.GaussianBlur(mat, blur, new cv.Size(0, 0), 1.2);
  cv.addWeighted(mat, 1 + amount, blur, -amount, 0, mat);
  blur.delete();
}

function filter(d, name) {
  var src = matFromImageData(d), rgb = new cv.Mat(), out = null;
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  try {
    if (name === 'original') { out = rgb.clone(); }
    else if (name === 'gray') { out = new cv.Mat(); cv.cvtColor(rgb, out, cv.COLOR_RGB2GRAY); }
    else if (name === 'photo') {
      out = new cv.Mat(); rgb.convertTo(out, -1, 1.08, 4);
      var hsv = new cv.Mat(); cv.cvtColor(out, hsv, cv.COLOR_RGB2HSV);
      var ch = new cv.MatVector(); cv.split(hsv, ch);
      var s = ch.get(1); s.convertTo(s, -1, 1.15, 0); ch.set(1, s);
      cv.merge(ch, hsv); cv.cvtColor(hsv, out, cv.COLOR_HSV2RGB);
      del(hsv, ch, s);
    }
    else if (name === 'document') {
      out = normalizeBackground(rgb);
      out.convertTo(out, -1, 1.12, -10);
      sharpen(out, 0.6);
    }
    else if (name === 'clear') {
      out = normalizeBackground(rgb);
      cv.medianBlur(out, out, 3);
      out.convertTo(out, -1, 1.25, -30);
      // ทำพื้นที่เกือบขาวให้ขาวสนิท แต่ไม่แตะส่วนที่มีสี (ตราประทับ/ลายเซ็น)
      var g = new cv.Mat(), mask = new cv.Mat();
      cv.cvtColor(out, g, cv.COLOR_RGB2GRAY);
      cv.threshold(g, mask, 215, 255, cv.THRESH_BINARY);
      out.setTo(new cv.Scalar(255, 255, 255), mask);
      del(g, mask);
      sharpen(out, 0.9);
    }
    else if (name === 'bw') {
      var norm = normalizeBackground(rgb), gray = new cv.Mat();
      cv.cvtColor(norm, gray, cv.COLOR_RGB2GRAY);
      out = new cv.Mat();
      var block = Math.max(15, (Math.round(Math.max(gray.cols, gray.rows) / 80) | 1));
      cv.adaptiveThreshold(gray, out, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block % 2 ? block : block + 1, 12);
      del(norm, gray);
    }
    else { out = rgb.clone(); }
    return toImageData(out);
  } finally { del(src, rgb, out); }
}

function adjust(d, a) {
  var src = matFromImageData(d), rgb = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  try {
    var alpha = 1 + a.contrast / 100, beta = a.brightness * 1.28 + 128 * (1 - alpha);
    rgb.convertTo(rgb, -1, alpha, beta);
    if (a.saturation) {
      var hsv = new cv.Mat(); cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      var ch = new cv.MatVector(); cv.split(hsv, ch);
      var s = ch.get(1); s.convertTo(s, -1, 1 + a.saturation / 100, 0); ch.set(1, s);
      cv.merge(ch, hsv); cv.cvtColor(hsv, rgb, cv.COLOR_HSV2RGB);
      del(hsv, ch, s);
    }
    if (a.sharpness > 0) sharpen(rgb, a.sharpness / 50);
    return toImageData(rgb);
  } finally { del(src, rgb); }
}

self.onmessage = function (e) {
  var msg = e.data;
  whenReady(function () {
    try {
      var result;
      if (msg.type === 'ping') result = { ok: true };
      else if (msg.type === 'detect') result = detect(msg.image);
      else if (msg.type === 'warp') result = warp(msg.image, msg.quad);
      else if (msg.type === 'filter') result = filter(msg.image, msg.name);
      else if (msg.type === 'adjust') result = adjust(msg.image, msg.adjust);
      else throw new Error('unknown op ' + msg.type);
      var transfer = result && result.data && result.data.buffer ? [result.data.buffer] : [];
      self.postMessage({ id: msg.id, ok: true, result: result }, transfer);
    } catch (err) {
      self.postMessage({ id: msg.id, ok: false, error: String(err && err.message || err) });
    }
  });
};
