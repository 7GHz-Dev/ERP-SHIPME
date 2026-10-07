import { markPreview, smsByCode, thShortDate } from '@/lib/sms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const preferredRegion = ['sin1'];

/**
 * หน้าที่คนขับรถเปิดจากลิงก์ใน SMS — ไม่ต้องล็อกอิน (รหัสลิงก์สุ่ม 8 ตัวคือกุญแจ)
 *   - og:image = รูปแผนที่นัดหมาย → แอปข้อความโชว์เป็น thumbnail ใต้ข้อความ
 *   - เปิดหน้า = ยิง linkOpened (นับว่าเปิดอ่าน) แล้วขอตำแหน่งทันทีถ้าชิปปิ้งติ๊กขอไว้
 * เป็น HTML ล้วนเหมือนหน้าอื่นของระบบ — โหลดเร็วบนมือถือคนขับที่เน็ตไม่ดี
 */

// บอททำตัวอย่างลิงก์ (iMessage ใช้ UA ของ facebookexternalhit, LINE ใช้ line-poker)
const PREVIEW_BOT = /bot|crawler|spider|facebookexternalhit|facebot|whatsapp|telegram|slack|discord|skype|embedly|line-poker|preview|okhttp|curl|wget|python/i;

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

const html = (body: string, status = 200) => new Response(body, {
  status,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' }
});

function shell(title: string, head: string, main: string, script = '') {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#002967">
<title>${esc(title)}</title>
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png">
${head}
<style>
  :root { --navy:#002967; --blue:#0058eb; --accent:#ffa202; --bg:#f1f5fb; --muted:#64748b; --ok:#166534; --okbg:#dcfce7; --err:#991b1b; --errbg:#fee2e2; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:#0f172a; font-family:-apple-system,'Segoe UI',Roboto,'Noto Sans Thai',sans-serif; font-size:16px; line-height:1.55; }
  header { background:#fff; padding:12px 16px; display:flex; justify-content:center; box-shadow:inset 0 -3px 0 var(--accent); }
  header img { height:42px; width:auto; display:block; }
  main { max-width:560px; margin:0 auto; padding:16px; }
  .card { background:#fff; border-radius:16px; padding:16px; margin-bottom:14px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  .lbl { font-size:13px; color:var(--muted); font-weight:700; margin-bottom:6px; }
  .msg { font-size:17px; font-weight:600; white-space:pre-wrap; word-break:break-word; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:12px; }
  .chip { background:#eef4ff; color:var(--navy); border-radius:999px; padding:4px 10px; font-size:13px; font-weight:700; }
  .map img { width:100%; height:auto; min-height:140px; display:block; border-radius:12px; border:1px solid #e2e8f0; background:#eef2f7; }
  .map .cap { font-size:13px; color:var(--muted); text-align:center; margin-top:6px; }
  .btn { display:block; width:100%; border:0; border-radius:12px; padding:15px; font-size:17px; font-weight:700; cursor:pointer;
         background:linear-gradient(135deg,#0058eb,#0a74f0); color:#fff; font-family:inherit; }
  .btn.ghost { background:#e2e8f0; color:#0f172a; margin-top:10px; }
  .st { border-radius:12px; padding:12px; font-size:15px; margin-bottom:12px; }
  .st.wait { background:#fef9c3; color:#854d0e; }
  .st.ok { background:var(--okbg); color:var(--ok); }
  .st.err { background:var(--errbg); color:var(--err); }
  .help { font-size:14px; color:#334155; margin:4px 0 12px; padding-left:18px; }
  .help li { margin-bottom:4px; }
  .foot { text-align:center; color:#94a3b8; font-size:12px; padding:8px 0 24px; }
  .center { text-align:center; padding:48px 16px; }
  .center .big { font-size:52px; }
  .hidden { display:none; }
</style>
</head>
<body>
<header><img src="/brand/logo.webp" alt="ERP SHIPME" width="160" height="42"></header>
<main>${main}</main>
<div class="foot">SHIPME Logistics</div>
${script}
</body>
</html>`;
}

function notice(icon: string, title: string, text: string, status: number) {
  return html(shell(title, '', `<div class="card center"><div class="big">${icon}</div><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`), status);
}

export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const found = await smsByCode(code);
  if (!found) return notice('🔍', 'ไม่พบลิงก์นี้', 'ลิงก์อาจพิมพ์ไม่ครบ กรุณาเปิดจากข้อความ SMS อีกครั้ง', 404);
  if (found.expired) return notice('⌛', 'ลิงก์นี้หมดอายุแล้ว', 'กรุณาติดต่อชิปปิ้งที่ส่งข้อความมา', 410);
  const { row } = found;

  const ua = request.headers.get('user-agent') || '';
  if (PREVIEW_BOT.test(ua)) await markPreview(code).catch(() => {});

  const origin = new URL(request.url).origin;
  const driver = row.driverName.trim().replace(/^(นาย|นาง(สาว)?|น\.ส\.|คุณ)\s*/, '');
  const hasMap = Boolean(row.mapKey);
  const image = hasMap ? `${origin}/d/${code}/map` : `${origin}/brand/icon-512.png`;
  const title = row.kind === 'ask' ? 'SHIPME: สอบถามคนขับรถ' : 'SHIPME: นัดหมายตรวจปล่อย';
  const head = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="ERP SHIPME">`,
    `<meta property="og:title" content="${esc(hasMap ? `${title} — แผนที่จุดนัด` : title)}">`,
    `<meta property="og:description" content="${esc(row.body.slice(0, 180))}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:url" content="${esc(`${origin}/d/${code}`)}">`,
    `<meta name="twitter:card" content="${hasMap ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:image" content="${esc(image)}">`
  ].join('\n');

  const chips = [
    row.containers && `ตู้ ${row.containers}`,
    `วันที่ ${thShortDate(row.inspectDate)}`,
    row.plate && `ทะเบียน ${row.plate}`
  ].filter(Boolean).map((chip) => `<span class="chip">${esc(chip)}</span>`).join('');

  const main = `
<div class="card">
  <div class="lbl">ข้อความจากชิปปิ้ง SHIPME${driver ? ` ถึงคุณ${esc(driver)}` : ''}</div>
  <div class="msg">${esc(row.body)}</div>
  <div class="chips">${chips}</div>
</div>
${row.withLocation ? `
<div class="card" id="loc-card">
  <div class="lbl">📍 แชร์ตำแหน่งปัจจุบันให้ชิปปิ้ง</div>
  <div id="loc-st" class="st wait">กำลังขอตำแหน่ง… กรุณากด “อนุญาต” เมื่อมือถือถาม</div>
  <ul id="loc-help" class="help hidden">
    <li><b>iPhone:</b> ตั้งค่า → ความเป็นส่วนตัว → บริการหาตำแหน่ง → เปิด แล้วเลือก Safari/Chrome เป็น “ขณะใช้งาน”</li>
    <li><b>Android:</b> แตะรูปกุญแจข้างช่องลิงก์ด้านบน → สิทธิ์ → ตำแหน่ง → อนุญาต และเปิด GPS ของเครื่อง</li>
    <li>แล้วกดปุ่มด้านล่างอีกครั้ง</li>
  </ul>
  <button id="loc-btn" class="btn" type="button">📍 แชร์ตำแหน่งของฉัน</button>
</div>` : ''}
${hasMap ? `
<div class="card map">
  <div class="lbl">🗺️ แผนที่จุดนัด / หน้างาน</div>
  <a href="/d/${esc(code)}/map" target="_blank" rel="noopener"><img src="/d/${esc(code)}/map" alt="แผนที่จุดนัด"></a>
  <div class="cap">แตะที่รูปเพื่อเปิดรูปเต็ม แล้วซูมดูได้</div>
</div>` : ''}`;

  const script = `<script>
(function(){
  var CODE=${JSON.stringify(code)}, WANT=${row.withLocation ? 'true' : 'false'};
  function post(p){ try { return fetch('/api',{method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify(p),keepalive:true}).then(function(r){return r.json();}).catch(function(){return {ok:false};}); } catch(e){ return Promise.resolve({ok:false}); } }
  post({action:'linkOpened', code:CODE});
  if(!WANT) return;
  var st=document.getElementById('loc-st'), btn=document.getElementById('loc-btn'), help=document.getElementById('loc-help');
  function show(cls, text){ st.className='st '+cls; st.textContent=text; }
  function ask(){
    if(!navigator.geolocation){ show('err','มือถือนี้ไม่รองรับการหาตำแหน่ง กรุณาโทรแจ้งชิปปิ้ง'); return; }
    btn.disabled=true; show('wait','กำลังหาตำแหน่ง… กรุณากด “อนุญาต” เมื่อมือถือถาม');
    navigator.geolocation.getCurrentPosition(function(p){
      var acc=Math.round(p.coords.accuracy||0);
      post({action:'linkLocation', code:CODE, lat:p.coords.latitude, lng:p.coords.longitude, accuracy:acc}).then(function(r){
        btn.disabled=false;
        if(r && r.ok){
          var t=new Date(); show('ok','✅ ส่งตำแหน่งให้ชิปปิ้งแล้ว ('+String(t.getHours()).padStart(2,'0')+':'+String(t.getMinutes()).padStart(2,'0')+' น. • แม่นยำ ±'+acc+' ม.) ขอบคุณครับ');
          btn.textContent='📍 ส่งตำแหน่งล่าสุดอีกครั้ง'; btn.className='btn ghost'; help.className='help hidden';
        } else { show('err','ส่งตำแหน่งไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'); }
      });
    }, function(e){
      btn.disabled=false;
      var denied = e && e.code===1;
      post({action:'linkLocation', code:CODE, status: denied?'denied':'unavailable'});
      show('err', denied ? 'ยังไม่ได้อนุญาตให้ใช้ตำแหน่ง' : 'หาตำแหน่งไม่ได้ กรุณาเปิด GPS แล้วลองใหม่');
      help.className='help';
    }, { enableHighAccuracy:true, timeout:20000, maximumAge:0 });
  }
  btn.addEventListener('click', ask);
  ask();
})();
</script>`;

  return html(shell(title, head, main, script));
}
