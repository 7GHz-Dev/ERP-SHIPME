/* eslint-disable */
/**
 * ปรับรูปเอกสารตรวจปล่อย (หน้าปิดบัญชี) — JavaScript ล้วน ไม่ต้องโหลด OpenCV
 *   process : ครอบ + ปรับมุมมองให้แบนเหมือนสแกน (perspective warp) แล้วทำพื้นกระดาษให้ขาว (ฟิลเตอร์ "เอกสาร")
 * ขั้นตอนเดียวกับฟิลเตอร์ document ของ DocScan (cv-worker.js): ประมาณสีพื้นกระดาษที่ความละเอียดต่ำ → หารออก
 * → เพิ่มคอนทราสต์ 1.12 / −10 → เพิ่มความคม — ตัวหนังสือ ลายเซ็น ตราประทับยังมีสีตามเดิม
 * รับ/คืน ImageData แบบโอน buffer — รูปไม่ออกจากเครื่อง
 */
'use strict';

/** แก้ระบบสมการ 8×8 (Gaussian elimination) */
function solve(A, b) {
  var n = b.length, i, j, k;
  for (i = 0; i < n; i++) {
    var p = i;
    for (j = i + 1; j < n; j++) if (Math.abs(A[j][i]) > Math.abs(A[p][i])) p = j;
    var t = A[i]; A[i] = A[p]; A[p] = t; var tb = b[i]; b[i] = b[p]; b[p] = tb;
    for (j = i + 1; j < n; j++) {
      var f = A[j][i] / A[i][i];
      for (k = i; k < n; k++) A[j][k] -= f * A[i][k];
      b[j] -= f * b[i];
    }
  }
  var x = new Array(n);
  for (i = n - 1; i >= 0; i--) {
    var s = b[i];
    for (k = i + 1; k < n; k++) s -= A[i][k] * x[k];
    x[i] = s / A[i][i];
  }
  return x;
}

/** homography ที่แปลงพิกัดภาพผลลัพธ์ (0..w, 0..h) → พิกัดบนภาพต้นฉบับ (มุม q บนซ้าย/บนขวา/ล่างขวา/ล่างซ้าย) */
function homography(q, w, h) {
  var from = [[0, 0], [w, 0], [w, h], [0, h]], A = [], b = [];
  for (var i = 0; i < 4; i++) {
    var x = from[i][0], y = from[i][1], u = q[i].x, v = q[i].y;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  var m = solve(A, b);
  m.push(1);
  return m;
}

/** ปรับมุมมอง — สุ่มสีแบบ bilinear (ขอบนอกภาพ = ใช้พิกเซลขอบ) • ผลลัพธ์ RGB 3 ช่อง (Float32 ไว้คำนวณต่อ) */
function warp(img, q, w, h) {
  var H = homography(q, w, h), sw = img.width, sh = img.height, s = img.data;
  var out = new Float32Array(w * h * 3), o = 0;
  for (var y = 0; y < h; y++) {
    var yy = y + 0.5;
    for (var x = 0; x < w; x++) {
      var xx = x + 0.5, d = H[6] * xx + H[7] * yy + 1;
      var u = (H[0] * xx + H[1] * yy + H[2]) / d - 0.5, v = (H[3] * xx + H[4] * yy + H[5]) / d - 0.5;
      if (u < 0) u = 0; else if (u > sw - 1) u = sw - 1;
      if (v < 0) v = 0; else if (v > sh - 1) v = sh - 1;
      var x0 = u | 0, y0 = v | 0, x1 = x0 < sw - 1 ? x0 + 1 : x0, y1 = y0 < sh - 1 ? y0 + 1 : y0;
      var fx = u - x0, fy = v - y0;
      var a = (y0 * sw + x0) * 4, bb = (y0 * sw + x1) * 4, c = (y1 * sw + x0) * 4, e = (y1 * sw + x1) * 4;
      for (var ch = 0; ch < 3; ch++) {
        var top = s[a + ch] + (s[bb + ch] - s[a + ch]) * fx, bot = s[c + ch] + (s[e + ch] - s[c + ch]) * fx;
        out[o++] = top + (bot - top) * fy;
      }
    }
  }
  return out;
}

/** สีพื้นกระดาษ: ย่อเหลือด้านยาว 360px (เฉลี่ยพื้นที่) → dilate 3×3 (ลบตัวหนังสือ) → median 7×7 */
function background(rgb, w, h) {
  var s = Math.min(1, 360 / Math.max(w, h));
  var bw = Math.max(8, Math.round(w * s)), bh = Math.max(8, Math.round(h * s));
  var sum = new Float32Array(bw * bh * 3), cnt = new Float32Array(bw * bh);
  var x, y, ch, i;
  for (y = 0; y < h; y++) {
    var by = Math.min(bh - 1, (y * bh / h) | 0);
    for (x = 0; x < w; x++) {
      var bx = Math.min(bw - 1, (x * bw / w) | 0), k = by * bw + bx, p = (y * w + x) * 3;
      sum[k * 3] += rgb[p]; sum[k * 3 + 1] += rgb[p + 1]; sum[k * 3 + 2] += rgb[p + 2]; cnt[k]++;
    }
  }
  for (i = 0; i < bw * bh; i++) for (ch = 0; ch < 3; ch++) sum[i * 3 + ch] /= Math.max(1, cnt[i]);
  var dil = new Float32Array(sum.length);
  for (y = 0; y < bh; y++) for (x = 0; x < bw; x++) for (ch = 0; ch < 3; ch++) {
    var m = 0;
    for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
      var yy = Math.min(bh - 1, Math.max(0, y + dy)), xx = Math.min(bw - 1, Math.max(0, x + dx));
      var val = sum[(yy * bw + xx) * 3 + ch]; if (val > m) m = val;
    }
    dil[(y * bw + x) * 3 + ch] = m;
  }
  var med = new Float32Array(sum.length), win = new Float32Array(49);
  for (y = 0; y < bh; y++) for (x = 0; x < bw; x++) for (ch = 0; ch < 3; ch++) {
    var n = 0;
    for (var dy2 = -3; dy2 <= 3; dy2++) for (var dx2 = -3; dx2 <= 3; dx2++) {
      var y2 = Math.min(bh - 1, Math.max(0, y + dy2)), x2 = Math.min(bw - 1, Math.max(0, x + dx2));
      win[n++] = dil[(y2 * bw + x2) * 3 + ch];
    }
    win.sort();
    med[(y * bw + x) * 3 + ch] = win[24];
  }
  return { d: med, w: bw, h: bh };
}

/** ฟิลเตอร์เอกสาร → ImageData RGBA */
function documentFilter(rgb, w, h) {
  var bg = background(rgb, w, h), B = bg.d, bw = bg.w, bh = bg.h;
  var n = w * h, lum = new Float32Array(n * 3), x, y, ch;
  // หารด้วยสีพื้น (ขยายพื้นแบบ bilinear) → คอนทราสต์ 1.12 / −10
  for (y = 0; y < h; y++) {
    var v = Math.max(0, Math.min(bh - 1, (y + 0.5) * bh / h - 0.5)), y0 = v | 0, y1 = Math.min(bh - 1, y0 + 1), fy = v - y0;
    for (x = 0; x < w; x++) {
      var u = Math.max(0, Math.min(bw - 1, (x + 0.5) * bw / w - 0.5)), x0 = u | 0, x1 = Math.min(bw - 1, x0 + 1), fx = u - x0;
      var p = (y * w + x) * 3;
      for (ch = 0; ch < 3; ch++) {
        var a = B[(y0 * bw + x0) * 3 + ch], b = B[(y0 * bw + x1) * 3 + ch], c = B[(y1 * bw + x0) * 3 + ch], d = B[(y1 * bw + x1) * 3 + ch];
        var bgv = (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
        var val = bgv > 0 ? rgb[p + ch] * 255 / bgv : 255;
        if (val > 255) val = 255;
        val = val * 1.12 - 10;
        lum[p + ch] = val < 0 ? 0 : (val > 255 ? 255 : val);
      }
    }
  }
  // เพิ่มความคม: unsharp mask (Gaussian 5×5 σ1) น้ำหนัก 0.6
  var K = [0.0545, 0.2442, 0.4026, 0.2442, 0.0545], tmp = new Float32Array(n * 3), k, xx, yy;
  for (y = 0; y < h; y++) for (x = 0; x < w; x++) for (ch = 0; ch < 3; ch++) {
    var s = 0;
    for (k = -2; k <= 2; k++) { xx = x + k; if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1; s += lum[(y * w + xx) * 3 + ch] * K[k + 2]; }
    tmp[(y * w + x) * 3 + ch] = s;
  }
  var out = new Uint8ClampedArray(n * 4);
  for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
    var o = (y * w + x) * 4;
    for (ch = 0; ch < 3; ch++) {
      var s2 = 0;
      for (k = -2; k <= 2; k++) { yy = y + k; if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1; s2 += tmp[(yy * w + x) * 3 + ch] * K[k + 2]; }
      out[o + ch] = lum[(y * w + x) * 3 + ch] * 1.6 - s2 * 0.6;
    }
    out[o + 3] = 255;
  }
  return new ImageData(out, w, h);
}

self.onmessage = function (e) {
  var m = e.data;
  try {
    if (m.type !== 'process') throw new Error('unknown');
    var w = Math.max(1, Math.round(m.size.w)), h = Math.max(1, Math.round(m.size.h));
    var out = documentFilter(warp(m.image, m.quad, w, h), w, h);
    self.postMessage({ id: m.id, ok: true, result: out }, [out.data.buffer]);
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) });
  }
};
