import type { MarkupObject } from './types';

/**
 * วาดชั้น markup ลงบน canvas — พิกัดในวัตถุเป็นสัดส่วน 0..1 ของหน้า
 * ใช้ทั้งตอนแก้ไข (วาดซ้อนบนหน้าจอ) และตอนบันทึก (วาดลงภาพจริง)
 */
const imageCache = new Map<string, HTMLImageElement>();
function loadImg(src: string): Promise<HTMLImageElement> {
  const hit = imageCache.get(src);
  if (hit && hit.complete) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const img = hit || new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('โหลดรูปลายเซ็นไม่สำเร็จ'));
    if (!hit) { img.src = src; imageCache.set(src, img); }
  });
}

export async function drawMarkup(ctx: CanvasRenderingContext2D, objs: MarkupObject[], w: number, h: number) {
  const unit = Math.max(w, h) / 1000;          // ความหนาเส้นคิดตามขนาดหน้า ไม่ใช่พิกเซลจอ
  for (const o of objs) {
    ctx.save();
    if (o.kind === 'stroke' || o.kind === 'erase') {
      if (o.points.length < 1) { ctx.restore(); continue; }
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.width * unit;
      if (o.kind === 'stroke' && o.tool === 'highlighter') { ctx.globalAlpha = 0.35; ctx.globalCompositeOperation = 'multiply'; }
      ctx.beginPath();
      o.points.forEach((p, i) => (i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h)));
      if (o.points.length === 1) ctx.lineTo(o.points[0].x * w + 0.1, o.points[0].y * h);
      ctx.stroke();
    } else if (o.kind === 'rect') {
      ctx.strokeStyle = o.color; ctx.lineWidth = o.width * unit;
      ctx.strokeRect(o.x * w, o.y * h, o.w * w, o.h * h);
    } else if (o.kind === 'text') {
      ctx.fillStyle = o.color;
      ctx.font = `${o.font.includes('bold') ? '700 ' : ''}${o.font.includes('italic') ? 'italic ' : ''}${o.size * unit}px "Sarabun", "Noto Sans Thai", sans-serif`;
      ctx.textAlign = o.align; ctx.textBaseline = 'top';
      o.text.split('\n').forEach((line, i) => ctx.fillText(line, o.x * w, o.y * h + i * o.size * unit * 1.3));
    } else if (o.kind === 'image') {
      const img = await loadImg(o.src);
      ctx.translate((o.x + o.w / 2) * w, (o.y + o.h / 2) * h);
      ctx.rotate((o.rotation * Math.PI) / 180);
      ctx.drawImage(img, (-o.w / 2) * w, (-o.h / 2) * h, o.w * w, o.h * h);
    }
    ctx.restore();
  }
}

/**
 * สีพื้นรอบ ๆ จุด (ค่ามัธยฐานของวงแหวนรอบแปรงลบ) — ยางลบจะทาด้วยสีกระดาษจริง ไม่ใช่ขาวล้วน
 * ภาพถ่ายกระดาษมักออกครีม/เทา ทาขาวล้วนแล้วจะเห็นเป็นรอยปะชัดเจน
 */
export function sampleBackground(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const ring: number[][] = [];
  const steps = 24;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const px = Math.round(x + Math.cos(a) * r * 1.6), py = Math.round(y + Math.sin(a) * r * 1.6);
    if (px < 0 || py < 0 || px >= ctx.canvas.width || py >= ctx.canvas.height) continue;
    const d = ctx.getImageData(px, py, 1, 1).data;
    ring.push([d[0], d[1], d[2]]);
  }
  if (!ring.length) return '#ffffff';
  // เอาจุดที่สว่างที่สุดครึ่งหนึ่ง (พื้นกระดาษ) ไม่เอาตัวหนังสือที่บังเอิญอยู่ในวงแหวน
  ring.sort((p, q) => (q[0] + q[1] + q[2]) - (p[0] + p[1] + p[2]));
  const top = ring.slice(0, Math.max(1, Math.ceil(ring.length / 2)));
  const mid = top[Math.floor(top.length / 2)];
  return `rgb(${mid[0]},${mid[1]},${mid[2]})`;
}
