/* eslint-disable */
/**
 * ตัวหาขอบเอกสารแบบเร็ว — JavaScript ล้วน ไม่ต้องรอโหลด OpenCV (10MB) จึงเริ่มจับกรอบได้ทันทีที่เปิดกล้อง
 * อยู่คนละ worker กับงานปรับภาพ (cv-worker.js) — ระหว่างบันทึกหน้าที่ถ่ายไว้ กล้องยังจับหน้าถัดไปได้ลื่น
 *
 * ทำไมจับได้แม้พื้นหลังสีใกล้กระดาษ:
 *  1) แยกภาพเป็น 3 ช่อง: ความสว่าง + แดง-เขียว + เหลือง-น้ำเงิน → กระดาษขาวบนโต๊ะครีม/ไม้อ่อน
 *     ที่สว่างพอ ๆ กันยังต่างกันที่ "โทนสี"
 *  2) รวมเกรเดียนต์ทั้ง 3 ช่อง (Di Zenzo) + ทำขอบให้บาง + เกณฑ์ขอบปรับตามสัญญาณรบกวนของภาพนั้น
 *     (ไม่ใช้ค่าตายตัวแบบ Canny 50/150 ที่ทิ้งขอบจาง ๆ ไปหมด)
 *  3) Hough transform หาเส้นตรงยาว — ขอบกระดาษจางแต่ยาวต่อเนื่องจึงสะสมคะแนนได้
 *     ส่วนลายพื้น/ตัวหนังสือเป็นเส้นสั้น ๆ คนละทิศ ไม่สะสม
 *  4) จับคู่เส้นแนวนอน 2 × แนวตั้ง 2 เป็นสี่เหลี่ยม แล้วให้คะแนน: มีขอบรองรับตลอดแนวทั้ง 4 ด้าน,
 *     ขนาด, ความต่างข้ามขอบ, ด้านในสว่างแบบกระดาษ (กันไปจับกระดานรองเขียน), สัดส่วนใกล้ A4
 *  5) ปรับมุมให้ละเอียดระดับเศษพิกเซลด้วยการ fit เส้นจากจุดขอบจริง
 *
 * คำสั่ง: detect (ภาพสดจากกล้อง / รูปนิ่ง) • refine (เกลากรอบบนภาพความละเอียดสูงตอนถ่ายจริง)
 * รูปไม่ออกจากเครื่อง — รับ ImageData แบบโอน buffer แล้วคืนแค่พิกัดมุม
 */
'use strict';

var NT = 180;                                   // ความละเอียดมุมของ Hough = 1°
var COS = new Float32Array(NT), SIN = new Float32Array(NT);
for (var t0 = 0; t0 < NT; t0++) { COS[t0] = Math.cos(t0 * Math.PI / NT); SIN[t0] = Math.sin(t0 * Math.PI / NT); }
var CHROMA_W = 1.6;     // น้ำหนักขอบที่ต่างกันแค่สี (ค่าสีต่างกันน้อยกว่าความสว่างโดยธรรมชาติ)
var SPREAD = 4;         // จุดขอบแต่ละจุดโหวตมุม ±4° รอบทิศเกรเดียนต์ของตัวเอง
var MIN_T = 7;          // เกณฑ์ขอบต่ำสุด (หน่วย Sobel ≈ 4 × ความต่างของความสว่าง)
var K_T = 2.2;          // เกณฑ์ขอบ = 2.2 × ค่ากลางเกรเดียนต์ของภาพ (≈ ระดับสัญญาณรบกวน)

var cache = {};
function buf(name, Type, n) {
  var a = cache[name];
  if (!a || a.length < n) { a = new Type(n); cache[name] = a; }
  return a;
}
function now() { return (self.performance && performance.now) ? performance.now() : Date.now(); }
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function dist(a, b) { return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)); }

// ---------- 1) เตรียมภาพ ----------
function blur(src, tmp, W, H) {
  // binomial [1 4 6 4 1]/16 แยกแนวนอน-แนวตั้ง (≈ Gaussian σ1)
  for (var y = 0; y < H; y++) {
    var o = y * W;
    for (var x = 0; x < W; x++) {
      var x0 = x < 2 ? 0 : x - 2, x1 = x < 1 ? 0 : x - 1, x3 = x + 1 >= W ? W - 1 : x + 1, x4 = x + 2 >= W ? W - 1 : x + 2;
      tmp[o + x] = (src[o + x0] + 4 * src[o + x1] + 6 * src[o + x] + 4 * src[o + x3] + src[o + x4]) * 0.0625;
    }
  }
  for (var yy = 0; yy < H; yy++) {
    var y0 = (yy < 2 ? 0 : yy - 2) * W, y1 = (yy < 1 ? 0 : yy - 1) * W, y2 = yy * W,
      y3 = (yy + 1 >= H ? H - 1 : yy + 1) * W, y4 = (yy + 2 >= H ? H - 1 : yy + 2) * W;
    for (var xx = 0; xx < W; xx++) {
      src[y2 + xx] = (tmp[y0 + xx] + 4 * tmp[y1 + xx] + 6 * tmp[y2 + xx] + 4 * tmp[y3 + xx] + tmp[y4 + xx]) * 0.0625;
    }
  }
}

function prepare(img) {
  var W = img.width, H = img.height, N = W * H, d = img.data;
  var L = buf('L', Float32Array, N), A = buf('A', Float32Array, N), B = buf('B', Float32Array, N);
  for (var i = 0, j = 0; i < N; i++, j += 4) {
    var r = d[j], g = d[j + 1], b = d[j + 2];
    L[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    A[i] = r - g;
    B[i] = 0.5 * (r + g) - b;
  }
  var tmp = buf('tmp', Float32Array, N);
  blur(L, tmp, W, H); blur(A, tmp, W, H); blur(B, tmp, W, H);
  // percentile ความสว่าง — ใช้ตัดสินว่าด้านในกรอบ "สว่างแบบกระดาษ" ไหม
  var hist = new Uint32Array(256), cnt = 0;
  for (i = 0; i < N; i += 2) { hist[L[i] | 0]++; cnt++; }
  var acc = 0, p50 = -1, p90 = -1;
  for (var k = 0; k < 256; k++) {
    acc += hist[k];
    if (p50 < 0 && acc >= cnt * 0.5) p50 = k;
    if (p90 < 0 && acc >= cnt * 0.9) { p90 = k; break; }
  }
  return { W: W, H: H, N: N, L: L, A: A, B: B, p50: p50, p90: p90 < 0 ? 255 : p90 };
}

// ---------- 2) เกรเดียนต์หลายช่อง + ขอบบาง ----------
function gradients(P) {
  var W = P.W, H = P.H, N = P.N, L = P.L, A = P.A, B = P.B, cw = CHROMA_W;
  var mag = buf('mag', Float32Array, N), ux = buf('ux', Float32Array, N), uy = buf('uy', Float32Array, N);
  for (var x0 = 0; x0 < W; x0++) { mag[x0] = 0; mag[N - W + x0] = 0; }
  for (var y = 1; y < H - 1; y++) {
    var row = y * W;
    mag[row] = 0; mag[row + W - 1] = 0;
    for (var x = 1; x < W - 1; x++) {
      var i = row + x, n = i - W, s = i + W;
      var gx = (L[n + 1] + 2 * L[i + 1] + L[s + 1]) - (L[n - 1] + 2 * L[i - 1] + L[s - 1]);
      var gy = (L[s - 1] + 2 * L[s] + L[s + 1]) - (L[n - 1] + 2 * L[n] + L[n + 1]);
      var ax = ((A[n + 1] + 2 * A[i + 1] + A[s + 1]) - (A[n - 1] + 2 * A[i - 1] + A[s - 1])) * cw;
      var ay = ((A[s - 1] + 2 * A[s] + A[s + 1]) - (A[n - 1] + 2 * A[n] + A[n + 1])) * cw;
      var bx = ((B[n + 1] + 2 * B[i + 1] + B[s + 1]) - (B[n - 1] + 2 * B[i - 1] + B[s - 1])) * cw;
      var by = ((B[s - 1] + 2 * B[s] + B[s + 1]) - (B[n - 1] + 2 * B[n] + B[n + 1])) * cw;
      var gxx = gx * gx + ax * ax + bx * bx, gyy = gy * gy + ay * ay + by * by, gxy = gx * gy + ax * ay + bx * by;
      var df = gxx - gyy, lam = 0.5 * (gxx + gyy + Math.sqrt(df * df + 4 * gxy * gxy));
      mag[i] = Math.sqrt(lam);
      var vx, vy;
      if (gxx >= gyy) { vx = lam - gyy; vy = gxy; } else { vx = gxy; vy = lam - gxx; }
      var nn = Math.sqrt(vx * vx + vy * vy);
      if (nn > 1e-9) { ux[i] = vx / nn; uy[i] = vy / nn; } else { ux[i] = 1; uy[i] = 0; }
    }
  }
  P.mag = mag; P.ux = ux; P.uy = uy;
}

/** เกณฑ์ขอบจากระดับสัญญาณรบกวนของภาพนั้น ๆ (ค่ากลางของเกรเดียนต์ — ส่วนใหญ่ของภาพเป็นพื้นเรียบ) */
function noiseThreshold(P) {
  var mag = P.mag, N = P.N, W = P.W, hist = new Uint32Array(512), cnt = 0;
  for (var i = W + 1; i < N - W; i += 3) { var m = mag[i]; hist[m < 511 ? m | 0 : 511]++; cnt++; }
  var half = cnt >> 1, acc = 0, med = 0;
  for (var k = 0; k < 512; k++) { acc += hist[k]; if (acc >= half) { med = k; break; } }
  return Math.max(MIN_T, K_T * (med + 0.5));
}

function edges(P) {
  var W = P.W, H = P.H, N = P.N, mag = P.mag, ux = P.ux, uy = P.uy;
  var thr = noiseThreshold(P);
  var E = buf('E', Uint8Array, N); E.fill(0, 0, N);
  var list = buf('elist', Int32Array, N), n = 0;
  for (var y = 2; y < H - 2; y++) {
    for (var x = 2; x < W - 2; x++) {
      var i = y * W + x, m = mag[i];
      if (m < thr) continue;
      var dx = ux[i], dy = uy[i];
      var o = (dy > 0.3827 ? W : (dy < -0.3827 ? -W : 0)) + (dx > 0.3827 ? 1 : (dx < -0.3827 ? -1 : 0));
      if (m >= mag[i + o] && m > mag[i - o]) { E[i] = 1; list[n++] = i; }
    }
  }
  P.E = E; P.elist = list; P.ecount = n; P.thr = thr;
}

// ---------- 3) Hough ----------
function hough(P) {
  var W = P.W, H = P.H, D = Math.ceil(Math.sqrt(W * W + H * H)), NR = 2 * D + 1;
  var acc = buf('acc', Float32Array, NT * NR); acc.fill(0, 0, NT * NR);
  var ux = P.ux, uy = P.uy, list = P.elist, n = P.ecount, K = 180 / Math.PI;
  for (var e = 0; e < n; e++) {
    var i = list[e], x = i % W, y = (i / W) | 0;
    var ang = Math.atan2(uy[i], ux[i]) * K;
    if (ang < 0) ang += 180;
    var tc = Math.round(ang);
    for (var dt = -SPREAD; dt <= SPREAD; dt++) {
      var t = tc + dt;
      if (t < 0) t += NT; else if (t >= NT) t -= NT;
      acc[t * NR + Math.round(x * COS[t] + y * SIN[t]) + D] += 1;
    }
  }
  P.acc = acc; P.D = D; P.NR = NR;
}

var PW_T = 2, PW_R = 3;
function isPeak(acc, t, r, v, NR) {
  for (var dt = -PW_T; dt <= PW_T; dt++) {
    var tt = t + dt, mirror = false;
    if (tt < 0) { tt += NT; mirror = true; } else if (tt >= NT) { tt -= NT; mirror = true; }
    var rc = mirror ? (NR - 1 - r) : r;          // ข้ามมุม 0°/180° = ρ กลับเครื่องหมาย
    var base = tt * NR;
    for (var dr = -PW_R; dr <= PW_R; dr++) {
      var rr = rc + dr;
      if (rr < 0 || rr >= NR || (dt === 0 && dr === 0)) continue;
      var w = acc[base + rr];
      if (w > v || (w === v && (dt < 0 || (dt === 0 && dr < 0)))) return false;
    }
  }
  return true;
}

function peaks(P, minVotes, maxN) {
  var acc = P.acc, NR = P.NR, D = P.D, out = [];
  for (var t = 0; t < NT; t++) {
    var base = t * NR;
    for (var r = 0; r < NR; r++) {
      var v = acc[base + r];
      if (v >= minVotes && isPeak(acc, t, r, v, NR)) out.push({ t: t, r: r, v: v });
    }
  }
  out.sort(function (a, b) { return b.v - a.v; });
  if (out.length > maxN) out.length = maxN;
  return out.map(function (p) { return { t: p.t, nx: COS[p.t], ny: SIN[p.t], rho: p.r - D, votes: p.v, pos: 0 }; });
}

function angDiff(a, b) { var d = Math.abs(a - b); return d > NT / 2 ? NT - d : d; }
/**
 * นับคะแนนเส้นใหม่จากจุดขอบที่อยู่บนเส้นจริง (ห่างไม่เกิน 1px และทิศขอบตรงกับเส้น) ทีละเส้นจากคะแนนสูงไปต่ำ
 * จุดขอบที่เส้นก่อนหน้า "จอง" ไปแล้วจะไม่นับซ้ำ — เส้นเงา (เอียงต่างกัน 1–2° ทับขอบยาวเส้นเดียวกัน
 * เช่นขอบกระดานรองเขียน) จึงเหลือคะแนนน้อยและหลุดไป ไม่มาแย่งที่ขอบกระดาษจริง
 */
function verifyLines(P, lines, minVotes) {
  var W = P.W, H = P.H, E = P.E, ux = P.ux, uy = P.uy, out = [];
  var claimed = buf('claimed', Uint8Array, P.N); claimed.fill(0, 0, P.N);
  var hit = buf('hitlist', Int32Array, 4 * (W + H));
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i], dx = -l.ny, dy = l.nx, x0 = l.nx * l.rho, y0 = l.ny * l.rho, cnt = 0;
    var smin = -1e9, smax = 1e9;
    if (Math.abs(dx) > 1e-6) { var a = (1 - x0) / dx, b = (W - 2 - x0) / dx; smin = Math.max(smin, Math.min(a, b)); smax = Math.min(smax, Math.max(a, b)); }
    if (Math.abs(dy) > 1e-6) { var c = (1 - y0) / dy, d = (H - 2 - y0) / dy; smin = Math.max(smin, Math.min(c, d)); smax = Math.min(smax, Math.max(c, d)); }
    for (var s2 = smin; s2 <= smax; s2 += 1) {
      var px = x0 + s2 * dx, py = y0 + s2 * dy;
      for (var o = -1; o <= 1; o++) {
        var xi = (px + l.nx * o + 0.5) | 0, yi = (py + l.ny * o + 0.5) | 0;
        if (xi < 1 || yi < 1 || xi >= W - 1 || yi >= H - 1) continue;
        var ii = yi * W + xi;
        if (E[ii] && !claimed[ii] && Math.abs(ux[ii] * l.nx + uy[ii] * l.ny) > 0.985) { hit[cnt++] = ii; break; }
      }
    }
    if (cnt >= minVotes) {
      for (var h = 0; h < cnt; h++) claimed[hit[h]] = 1;
      l.votes = cnt; out.push(l);
    }
  }
  out.sort(function (p, q) { return q.votes - p.votes; });
  return out;
}

function sameLine(a, b) {
  // กันซ้ำเฉพาะเส้นเดียวกันจริง ๆ (ขอบกระดาษกับขอบกระดานรองเขียนห่างกันแค่ไม่กี่ px ต้องแยกกัน)
  var dt = Math.abs(a.t - b.t);
  if (dt <= 2) return Math.abs(a.rho - b.rho) <= 3;
  if (dt >= NT - 2) return Math.abs(a.rho + b.rho) <= 3;
  return false;
}

/** แยกเส้นแนวนอน/แนวตั้ง แล้วเลือกเส้นที่จะเอาไปจับคู่ */
function families(lines, W, H, K) {
  var hs = [], vs = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i], fam = Math.abs(l.ny) >= Math.abs(l.nx) ? hs : vs, dup = false;
    for (var j = 0; j < fam.length; j++) if (sameLine(fam[j], l)) { dup = true; break; }
    if (!dup) fam.push(l);
  }
  // ตำแหน่งของเส้นที่กลางภาพ + ที่ขอบภาพสองฝั่ง (ใช้ดูว่าสองเส้นซ้อนกันจริงหรือแค่ตัดกัน)
  hs.forEach(function (l) { l.pos = (l.rho - l.nx * W / 2) / l.ny; l.p0 = l.rho / l.ny; l.p1 = (l.rho - l.nx * W) / l.ny; });
  vs.forEach(function (l) { l.pos = (l.rho - l.ny * H / 2) / l.nx; l.p0 = l.rho / l.nx; l.p1 = (l.rho - l.ny * H) / l.nx; });
  return { h: pick(hs, K), v: pick(vs, K) };
}
/**
 * เลือกเส้นไปจับคู่ — จัดกลุ่มตามมุม (±2°) แล้วเอาแต่ละกลุ่ม: คะแนนสูงสุด 3 เส้น + เส้นนอกสุดฝั่งละ 3
 * - ลายที่ซ้ำ ๆ ขนานกัน (ผ้าปูโต๊ะลายทาง กระเบื้อง บรรทัดตัวหนังสือ) จะไม่แย่งที่เส้นอื่นจนหมด
 * - ขอบกระดาษบนพื้นสีเดียวกันมักจางกว่าเส้นตารางในเอกสาร แต่อยู่นอกสุดของกลุ่มมุมเดียวกันเสมอ
 */
function pick(fam, K) {
  var groups = [];
  for (var i = 0; i < fam.length; i++) {
    var l = fam[i], g = null;
    for (var j = 0; j < groups.length; j++) if (angDiff(groups[j].t, l.t) <= 2) { g = groups[j]; break; }
    if (!g) { g = { t: l.t, lines: [] }; groups.push(g); }
    g.lines.push(l);
  }
  var out = [];
  var add = function (l) { if (out.indexOf(l) < 0) out.push(l); };
  for (var k = 0; k < groups.length && out.length < K + 6; k++) {
    var gl = groups[k].lines;
    for (var a = 0; a < Math.min(3, gl.length); a++) add(gl[a]);
    var byPos = gl.slice().sort(function (x, y) { return x.pos - y.pos; });
    // นอกสุดฝั่งละ 3 เส้นที่ "อยู่คนละตำแหน่ง" (เส้นซ้อนกันห่างไม่ถึง 6px นับเป็นเส้นเดียว)
    for (var side = 0; side < 2; side++) {
      var taken = 0, last = null;
      for (var b = 0; b < byPos.length && taken < 3; b++) {
        var lb = byPos[side ? byPos.length - 1 - b : b];
        if (last && Math.abs(lb.p0 - last.p0) < 6 && Math.abs(lb.p1 - last.p1) < 6) continue;
        add(lb); last = lb; taken++;
      }
    }
  }
  return out;
}

function inter(a, b) {
  var det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 0.5) return null;          // เกือบขนาน (ทำมุมกันน้อยกว่า 30°)
  return { x: (a.rho * b.ny - a.ny * b.rho) / det, y: (a.nx * b.rho - a.rho * b.nx) / det };
}
function lineThrough(a, b) {
  var ex = b.x - a.x, ey = b.y - a.y, len = Math.sqrt(ex * ex + ey * ey) || 1, nx = -ey / len, ny = ex / len;
  return { nx: nx, ny: ny, rho: nx * a.x + ny * a.y };
}
function polyArea(q) {
  var s = 0;
  for (var i = 0; i < 4; i++) { var a = q[i], b = q[(i + 1) & 3]; s += a.x * b.y - b.x * a.y; }
  return Math.abs(s) / 2;
}

/** สี่เหลี่ยมนูน มุมไม่บิดเกิน 50°–130° ด้านไม่สั้นเกิน และอยู่ในภาพ (เผื่อเลยขอบได้นิดหน่อย) */
function validQuad(q, W, H, minArea) {
  var m = 0.03 * Math.max(W, H), minSide = 0.15 * Math.min(W, H);
  for (var i = 0; i < 4; i++) {
    var p = q[i];
    if (!p || p.x < -m || p.y < -m || p.x > W + m || p.y > H + m) return false;
  }
  for (i = 0; i < 4; i++) {
    var p0 = q[(i + 3) & 3], p1 = q[i], p2 = q[(i + 1) & 3];
    var ax = p0.x - p1.x, ay = p0.y - p1.y, bx = p2.x - p1.x, by = p2.y - p1.y;
    var la = Math.sqrt(ax * ax + ay * ay), lb = Math.sqrt(bx * bx + by * by);
    if (la < minSide || lb < minSide) return false;
    var c = (ax * bx + ay * by) / (la * lb);
    if (c > 0.64 || c < -0.64) return false;
    var ex = p1.x - p0.x, ey = p1.y - p0.y;            // ลำดับมุมตามเข็มนาฬิกา (แกน y ชี้ลง)
    if (ex * by - ey * bx <= 0) return false;
  }
  var a = polyArea(q) / (W * H);
  return a >= minArea && a <= 0.995;
}

function aspectFactor(q) {
  var w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2, h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  var r = w > h ? w / h : h / w;
  if (r >= 1.18 && r <= 1.68) return 1;           // A4 (1.414) รวมผลมุมกล้องเอียง
  if (r <= 2.0) return 0.92;
  return 0.8;
}

// ---------- 4) ให้คะแนนสี่เหลี่ยม ----------
var CS = new Float32Array(64);
function medianOf(a, n) {
  // insertion sort ของตัวอย่างไม่เกิน 24 ค่า — เร็วกว่า Array.sort
  for (var i = 1; i < n; i++) { var v = a[i], j = i - 1; while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; } a[j + 1] = v; }
  return n ? a[n >> 1] : 0;
}
function scoreQuad(q, P, minSup) {
  var W = P.W, H = P.H, E = P.E, ux = P.ux, uy = P.uy, L = P.L, A = P.A, B = P.B;
  var cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  var supSum = 0, supMin = 1, weak = 0, cSum = 0, cN = 0, inSum = 0, fP = 1, extHit = 0, extN = 0;
  for (var s = 0; s < 4; s++) {
    var a = q[s], b = q[(s + 1) & 3];
    var ex = b.x - a.x, ey = b.y - a.y, len = Math.sqrt(ex * ex + ey * ey);
    var nx = -ey / len, ny = ex / len;
    if (((a.x + b.x) / 2 - cx) * nx + ((a.y + b.y) / 2 - cy) * ny < 0) { nx = -nx; ny = -ny; }   // ชี้ออกนอกกรอบ
    var n = (len / 3) | 0; if (n < 12) n = 12; else if (n > 48) n = 48;
    var hits = 0, q0 = 0, q1 = 0, q2 = 0, q3 = 0, dSum = 0, dN = 0, csN = 0;
    for (var k = 0; k < n; k++) {
      var tt = 0.04 + 0.92 * (k + 0.5) / n, px = a.x + ex * tt, py = a.y + ey * tt;
      for (var o = -2; o <= 2; o++) {
        var sx = (px + nx * o + 0.5) | 0, sy = (py + ny * o + 0.5) | 0;
        if (sx < 1 || sy < 1 || sx >= W - 1 || sy >= H - 1) continue;
        var ii = sy * W + sx;
        if (E[ii] && Math.abs(ux[ii] * nx + uy[ii] * ny) > 0.92) {
          hits++;
          var qd = (tt * 4) | 0;
          if (qd === 0) q0++; else if (qd === 1) q1++; else if (qd === 2) q2++; else q3++;
          break;
        }
      }
      if ((k & 1) === 0) {
        // ความต่างข้ามขอบ (ด้านใน 3px vs ด้านนอก 3px): ขอบกระดาษต่างกัน, เส้นตารางในกระดาษสองฝั่งเหมือนกัน
        var ix = (px - nx * 3 + 0.5) | 0, iy = (py - ny * 3 + 0.5) | 0, ox = (px + nx * 3 + 0.5) | 0, oy = (py + ny * 3 + 0.5) | 0;
        if (ix >= 0 && iy >= 0 && ix < W && iy < H && ox >= 0 && oy >= 0 && ox < W && oy < H) {
          var ia = iy * W + ix, oa = oy * W + ox;
          CS[csN++] = Math.abs(L[ia] - L[oa]) + 0.7 * (Math.abs(A[ia] - A[oa]) + Math.abs(B[ia] - B[oa]));
          inSum += L[ia]; cN++;
          dSum += L[ia] - L[oa]; dN++;
        }
      }
    }
    // ขอบกระดาษจบที่มุม — เส้นที่ยาวเลยมุมออกไปต่อ (ลายผ้าปูโต๊ะ ขอบโต๊ะ กระเบื้อง) ไม่น่าใช่ขอบกระดาษ
    var ext = Math.min(30, 0.25 * len), dx = ex / len, dy = ey / len;
    for (var e2 = 0; e2 < 2; e2++) {
      var bx0 = e2 ? b.x : a.x, by0 = e2 ? b.y : a.y, sg = e2 ? 1 : -1;
      for (var k2 = 1; k2 <= 6; k2++) {
        var dd2 = 3 + (ext - 3) * k2 / 6, ex0 = bx0 + sg * dx * dd2, ey0 = by0 + sg * dy * dd2;
        if (ex0 < 2 || ey0 < 2 || ex0 >= W - 2 || ey0 >= H - 2) continue;
        extN++;
        for (var o2 = -1; o2 <= 1; o2++) {
          var jj = ((ey0 + ny * o2 + 0.5) | 0) * W + ((ex0 + nx * o2 + 0.5) | 0);
          if (E[jj] && Math.abs(ux[jj] * nx + uy[jj] * ny) > 0.92) { extHit++; break; }
        }
      }
    }
    var sup = hits / n;
    supSum += sup; if (sup < supMin) supMin = sup;
    // ค่ากลาง ไม่ใช่ค่าเฉลี่ย: เส้นตาราง/หัวกระดาษในเอกสารมีตัวหนังสือติดเป็นช่วง ๆ ทำให้ค่าเฉลี่ยสูงหลอก
    // ส่วนขอบกระดาษต่างกันสม่ำเสมอตลอดแนว
    cSum += medianOf(CS, csN);
    // ด้านในขอบต้องไม่มืดกว่าด้านนอก (กระดาษสว่างกว่าพื้น/กระดานรองเขียน) — คิดทีละด้าน
    // กันกรอบลูกผสม "ขอบกระดาษ 2 ด้าน + ขอบกระดาน 2 ด้าน" ที่ใหญ่กว่าเลยได้คะแนนพื้นที่มากกว่า
    if (dN) { var dd = dSum / dN; if (dd < -3) fP *= dd <= -15 ? 0.75 : 1 - 0.25 * (-3 - dd) / 12; }
    var qn = 0.3 * n / 4;
    if ((q0 >= qn) + (q1 >= qn) + (q2 >= qn) + (q3 >= qn) < 3) weak++;
  }
  var supAvg = supSum / 4;
  // ยอมให้นิ้วบังขอบได้ 1 ด้าน แต่ภาพรวมต้องมีขอบรองรับจริง
  if (supAvg < minSup || supMin < 0.22 || weak > 1) return null;
  var area = polyArea(q) / (W * H);
  var contrast = cSum / 4;
  // ความต่างข้ามขอบช่วยได้แค่เล็กน้อย — ขอบระหว่างกลุ่มตัวหนังสือกับที่ว่างในเอกสารก็ต่างกันได้มาก
  var fC = 0.85 + 0.15 * Math.min(1, contrast / 10);
  var fM = 0.5 + 0.5 * supMin;                    // ด้านที่อ่อนสุดต้องมีขอบจริงด้วย ไม่ใช่แค่ค่าเฉลี่ยดี
  var lin = cN ? inSum / cN : 0;
  var fG = 0.85 + 0.15 * clamp01((lin - P.p50) / (P.p90 - P.p50 + 6));
  var extSup = extN ? extHit / extN : 0;
  var fX = 1 - 0.5 * clamp01((extSup - 0.2) / 0.6);
  var score = Math.sqrt(supAvg) * Math.sqrt(area) * fC * fM * fP * fG * fX * aspectFactor(q);
  return { quad: q, score: score, sup: supAvg, supMin: supMin, area: area, contrast: contrast };
}

function meanCornerDist(a, b) {
  return (dist(a[0], b[0]) + dist(a[1], b[1]) + dist(a[2], b[2]) + dist(a[3], b[3])) / 4;
}

function bestQuad(P, F, o) {
  var W = P.W, H = P.H, hs = F.h, vs = F.v, best = null, n = 0;
  var diag = Math.sqrt(W * W + H * H), prev = o.prev;
  for (var i = 0; i < hs.length; i++) for (var j = i + 1; j < hs.length; j++) {
    var top = hs[i].pos <= hs[j].pos ? hs[i] : hs[j], bot = top === hs[i] ? hs[j] : hs[i];
    if (bot.pos - top.pos < 0.18 * H) continue;
    for (var k = 0; k < vs.length; k++) for (var l = k + 1; l < vs.length; l++) {
      var left = vs[k].pos <= vs[l].pos ? vs[k] : vs[l], right = left === vs[k] ? vs[l] : vs[k];
      if (right.pos - left.pos < 0.18 * W) continue;
      var q = [inter(top, left), inter(top, right), inter(bot, right), inter(bot, left)];
      if (!validQuad(q, W, H, o.minArea)) continue;
      n++;
      var s = scoreQuad(q, P, o.minSup);
      if (!s) continue;
      // ใกล้กรอบของเฟรมก่อน = ให้แต้มต่อนิดหน่อย กรอบจะไม่กระโดดไปมา
      if (prev && meanCornerDist(q, prev) < 0.025 * diag) s.score *= 1.1;
      if (!best || s.score > best.score) best = s;
    }
  }
  // กรอบเดิมจากเฟรมก่อน (เผื่อเฟรมนี้ขอบจางจนหาเส้นไม่ครบ) — ใช้ต่อได้ถ้าขอบยังรองรับอยู่
  if (prev && validQuad(prev, W, H, o.minArea * 0.8)) {
    var ps = scoreQuad(prev, P, o.minSup * 0.85);
    if (ps) { ps.score *= 1.05; if (!best || ps.score > best.score) best = ps; }
  }
  P.candidates = n;
  return best;
}

// ---------- 5) เกลามุมให้ละเอียด ----------
var RB = new Float32Array(512);
function resp(P, x, y, nx, ny) {
  var W = P.W, H = P.H;
  if (x < 1 || y < 1 || x >= W - 2 || y >= H - 2) return 0;
  var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * W + x0, m = P.mag;
  var v = (m[i] * (1 - fx) + m[i + 1] * fx) * (1 - fy) + (m[i + W] * (1 - fx) + m[i + W + 1] * fx) * fy;
  var ii = (fx < 0.5 ? i : i + 1) + (fy < 0.5 ? 0 : W);
  var al = Math.abs(P.ux[ii] * nx + P.uy[ii] * ny);
  return al > 0.8 ? v * al : 0;
}
function sampleL(P, x, y) {
  var W = P.W, H = P.H;
  if (x < 0 || y < 0 || x >= W - 1 || y >= H - 1) return -1;
  var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * W + x0, L = P.L;
  return (L[i] * (1 - fx) + L[i + 1] * fx) * (1 - fy) + (L[i + W] * (1 - fx) + L[i + W + 1] * fx) * fy;
}
/** แรงขอบ + ทิศ "ด้านในสว่างกว่าด้านนอก" (ขอบกระดาษ) — ขอบนอกของเงากระดาษกลับทิศ (ด้านในมืดกว่า) จึงได้น้ำหนักน้อย */
function respIn(P, x, y, nx, ny) {
  var v = resp(P, x, y, nx, ny);
  if (!v) return 0;
  var lin = sampleL(P, x - nx * 1.5, y - ny * 1.5), lout = sampleL(P, x + nx * 1.5, y + ny * 1.5);
  return lin < 0 || lout < 0 || lin + 1 >= lout ? v : v * 0.35;
}
function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s.length ? s[s.length >> 1] : 0; }
function pca(xs, ys, ws, keep) {
  var sw = 0, mx = 0, my = 0, i;
  for (i = 0; i < xs.length; i++) { if (keep && !keep[i]) continue; sw += ws[i]; mx += ws[i] * xs[i]; my += ws[i] * ys[i]; }
  if (sw <= 0) return null;
  mx /= sw; my /= sw;
  var sxx = 0, syy = 0, sxy = 0;
  for (i = 0; i < xs.length; i++) {
    if (keep && !keep[i]) continue;
    var dx = xs[i] - mx, dy = ys[i] - my;
    sxx += ws[i] * dx * dx; syy += ws[i] * dy * dy; sxy += ws[i] * dx * dy;
  }
  var ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), nx = -Math.sin(ang), ny = Math.cos(ang);
  return { nx: nx, ny: ny, rho: nx * mx + ny * my };
}
function fitLine(xs, ys, ws) {
  var l = pca(xs, ys, ws, null);
  if (!l) return null;
  var res = xs.map(function (x, i) { return Math.abs(l.nx * x + l.ny * ys[i] - l.rho); });
  var lim = Math.max(0.8, 2.5 * median(res));
  var keep = res.map(function (r) { return r <= lim; });
  return pca(xs, ys, ws, keep) || l;
}

/**
 * เกลาแต่ละด้านให้ตรงขอบจริง แล้ว fit เส้นใหม่ → มุม = จุดตัดของเส้น
 *  1) กวาดหาเส้นตรงที่ "ขอบรวมทั้งแนว" แรงที่สุด โดยเลื่อนปลายทั้งสองข้างของด้านได้คนละ ±R px
 *     (รวมคะแนนตลอดทั้งด้าน จึงไม่หลงไปเกาะจุดรบกวน/ตัวหนังสือใกล้ขอบเหมือนการหาทีละจุด)
 *  2) รอบเส้นนั้น หาตำแหน่งขอบละเอียดระดับเศษพิกเซลทีละจุด (±2px) แล้ว fit เส้นแบบตัดค่าผิดปกติ
 */
function refineQuad(q, P, R) {
  var lines = [], diag = Math.sqrt(P.W * P.W + P.H * P.H), r2 = 2;
  var cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  for (var s = 0; s < 4; s++) {
    var a = q[s], b = q[(s + 1) & 3];
    var ex = b.x - a.x, ey = b.y - a.y, len = Math.sqrt(ex * ex + ey * ey);
    if (len < 8) return null;
    var nx = -ey / len, ny = ex / len;
    if (((a.x + b.x) / 2 - cx) * nx + ((a.y + b.y) / 2 - cy) * ny < 0) { nx = -nx; ny = -ny; }   // ชี้ออกนอกกรอบ
    var n = Math.max(16, Math.min(80, Math.round(len / 3)));
    // 1) กวาด
    var bestV = -1, bo1 = 0, bo2 = 0;
    for (var o1 = -R; o1 <= R; o1++) for (var o2 = -R; o2 <= R; o2++) {
      var sum = 0;
      for (var k = 0; k < n; k++) {
        var tt = 0.06 + 0.88 * (k + 0.5) / n, o = o1 + (o2 - o1) * tt;
        sum += respIn(P, a.x + ex * tt + nx * o, a.y + ey * tt + ny * o, nx, ny);
      }
      if (sum > bestV) { bestV = sum; bo1 = o1; bo2 = o2; }
    }
    // 2) ละเอียดทีละจุดรอบเส้นที่กวาดได้
    var m = Math.max(16, Math.min(160, Math.round(len / 2))), xs = [], ys = [], ws = [], last = 2 * r2;
    for (var j = 0; j < m; j++) {
      var t2 = 0.06 + 0.88 * (j + 0.5) / m, base = bo1 + (bo2 - bo1) * t2;
      var px = a.x + ex * t2 + nx * base, py = a.y + ey * t2 + ny * base, gmax = 0, gi = -1;
      for (var d = -r2; d <= r2; d++) { var v = respIn(P, px + nx * d, py + ny * d, nx, ny); RB[d + r2] = v; if (v > gmax) { gmax = v; gi = d + r2; } }
      if (gmax < P.thr || gi <= 0 || gi >= last) continue;          // ยอดต้องอยู่ข้างใน ไม่ใช่ที่ขอบช่วงค้นหา
      var y0 = RB[gi - 1], y1 = RB[gi], y2 = RB[gi + 1], den = y0 - 2 * y1 + y2;
      var off = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / den)) : 0;
      var dd = gi - r2 + off;
      xs.push(px + nx * dd); ys.push(py + ny * dd); ws.push(Math.sqrt(y1));
    }
    var swept = lineThrough({ x: a.x + nx * bo1, y: a.y + ny * bo1 }, { x: b.x + nx * bo2, y: b.y + ny * bo2 });
    lines.push(xs.length >= Math.max(8, m * 0.3) ? (fitLine(xs, ys, ws) || swept) : swept);
  }
  var out = [inter(lines[3], lines[0]), inter(lines[0], lines[1]), inter(lines[1], lines[2]), inter(lines[2], lines[3])];
  var lim = Math.max(R * 2.5, 0.01 * diag);
  for (var i = 0; i < 4; i++) if (!out[i] || dist(out[i], q[i]) > lim) return null;
  return out;
}

function clampQuad(q, W, H) {
  return q.map(function (p) { return { x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(H, p.y)) }; });
}

/** ลายนิ้วมือของเนื้อหาในกรอบ (12×16 จุด) — ใช้ดูว่าเปลี่ยนเป็นหน้าใหม่แล้วหรือยัง ตอนถ่ายต่อเนื่อง */
function signature(q, P) {
  var GW = 12, GH = 16, W = P.W, H = P.H, L = P.L, v = new Array(GW * GH), sum = 0;
  for (var gy = 0; gy < GH; gy++) for (var gx = 0; gx < GW; gx++) {
    var acc = 0;
    for (var sy = 0; sy < 2; sy++) for (var sx = 0; sx < 2; sx++) {
      var u = 0.06 + 0.88 * (gx + 0.25 + 0.5 * sx) / GW, w = 0.06 + 0.88 * (gy + 0.25 + 0.5 * sy) / GH;
      var x = (1 - w) * ((1 - u) * q[0].x + u * q[1].x) + w * ((1 - u) * q[3].x + u * q[2].x);
      var y = (1 - w) * ((1 - u) * q[0].y + u * q[1].y) + w * ((1 - u) * q[3].y + u * q[2].y);
      var xi = Math.min(W - 1, Math.max(0, Math.round(x))), yi = Math.min(H - 1, Math.max(0, Math.round(y)));
      acc += L[yi * W + xi];
    }
    v[gy * GW + gx] = acc / 4; sum += acc / 4;
  }
  var mean = sum / v.length, v2 = 0, i;
  for (i = 0; i < v.length; i++) { v[i] -= mean; v2 += v[i] * v[i]; }
  var sd = Math.sqrt(v2 / v.length);
  for (i = 0; i < v.length; i++) v[i] = sd > 1.5 ? Math.round(v[i] / sd * 1000) / 1000 : 0;
  return { v: v, sd: sd, mean: mean };
}

var MODES = {
  live: { minVotes: 0.1, K: 12, minArea: 0.1, minSup: 0.45 },
  still: { minVotes: 0.08, K: 14, minArea: 0.06, minSup: 0.42 }
};

function detect(img, opts) {
  var t = now(), o = MODES[opts && opts.mode] || MODES.live;
  var P = prepare(img);
  gradients(P);
  edges(P);
  hough(P);
  var minVotes = Math.max(12, o.minVotes * Math.min(P.W, P.H));
  var lines = verifyLines(P, peaks(P, minVotes, 120), minVotes * 0.8);
  var F = families(lines, P.W, P.H, o.K);
  var best = bestQuad(P, F, { minArea: o.minArea, minSup: o.minSup, prev: opts && opts.prev });
  var info = { ms: 0, edges: P.ecount, lines: lines.length, candidates: P.candidates || 0, w: P.W, h: P.H };
  if (!best) { info.ms = Math.round(now() - t); return { quad: null, score: 0, area: 0, info: info }; }
  var q = refineQuad(best.quad, P, 2) || best.quad;
  q = clampQuad(q, P.W, P.H);
  var sig = signature(q, P);
  info.ms = Math.round(now() - t);
  return { quad: q, score: best.score, sup: best.sup, supMin: best.supMin, area: best.area, contrast: best.contrast, sig: sig, info: info };
}

/**
 * เกลากรอบบนภาพความละเอียดสูงขึ้น (ตอนถ่ายจริง) — quad ต้องอยู่ในพิกัดของภาพที่ส่งมา
 * radius = ระยะค้นหา ควรเท่ากับความคลาดเคลื่อนที่คาดไว้ของกรอบเดิม (ใหญ่ไปจะไปเกาะเส้นตารางในเอกสาร)
 */
function refine(img, quad, radius) {
  var P = prepare(img);
  gradients(P);
  P.thr = noiseThreshold(P);
  var R1 = Math.max(3, Math.min(24, Math.round(radius || Math.max(P.W, P.H) * 0.006)));
  var q = refineQuad(quad, P, R1) || quad;
  q = refineQuad(q, P, 3) || q;
  return { quad: clampQuad(q, P.W, P.H) };
}

self.onmessage = function (e) {
  var m = e.data;
  try {
    var result;
    if (m.type === 'detect') result = detect(m.image, m.opts || {});
    else if (m.type === 'refine') result = refine(m.image, m.quad, m.radius);
    else if (m.type === 'ping') result = { ok: true };
    else throw new Error('unknown op ' + m.type);
    self.postMessage({ id: m.id, ok: true, result: result });
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) });
  }
};
