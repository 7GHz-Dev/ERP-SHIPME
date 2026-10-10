'use client';
import { Check, Cloud, CloudDownload, CloudUpload, HardDrive, LogIn, LogOut, RefreshCw, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cloudLogin, cloudLogout, cloudStats, moveToCloud, moveToLocal, pullFromCloud, setMode, syncNow, useCloudStatus } from '@/lib/cloud';
import { db } from '@/lib/db';
import { formatBytes } from '@/lib/image';
import type { StorageMode } from '@/lib/types';
import { Button, Spinner, friendlyError, inputCls, useUi } from './ui';

const USER_KEY = 'docscan.erpUser';   // ใช้ร่วมกับหน้าส่งไปปิดบัญชี (จำแค่ชื่อผู้ใช้)

/**
 * ตั้งค่า → ที่เก็บเอกสาร: เก็บในเครื่องนี้ / ให้ระบบเก็บ (มือถือพื้นที่เต็ม)
 * เลือกให้ระบบเก็บ = ใส่รหัส ERP ครั้งเดียว แล้วเลือกได้ว่าจะย้ายเอกสารเดิมขึ้นไปด้วยไหม
 * ค่านี้กำหนดที่เก็บของ "เอกสารใหม่" — เอกสารเดิมย้ายไปมาได้ทั้งหมดที่นี่ หรือทีละเอกสารจากเมนูของเอกสาร
 */
export default function StorageSettings() {
  const ui = useUi();
  const s = useCloudStatus();
  const [stats, setStats] = useState<Awaited<ReturnType<typeof cloudStats>> | null>(null);
  const [form, setForm] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { cloudStats().then(setStats); }, [s.pending, s.lastSync, s.mode, s.session, busy]);
  useEffect(() => { try { setUsername(localStorage.getItem(USER_KEY) || ''); } catch { /* โหมดส่วนตัว */ } }, []);

  const enableCloud = async () => {
    await setMode('cloud');
    const st = await cloudStats();
    if (st.localDocs && await ui.confirm('ย้ายเอกสารเดิมขึ้นระบบด้วยไหม?',
      `มีเอกสารในเครื่อง ${st.localDocs} รายการ (${formatBytes(st.localBytes)}) — ย้ายแล้วรูปในเครื่องจะถูกลบเมื่ออัปเสร็จ ช่วยคืนพื้นที่มือถือ`,
      { ok: 'ย้ายทั้งหมด' })) {
      await moveAllUp();
    } else {
      ui.toast('เอกสารใหม่จะให้ระบบเก็บ');
    }
  };
  const moveAllUp = async () => {
    const ids = (await db.documents.filter((d) => d.storage !== 'cloud').primaryKeys()) as string[];
    await moveToCloud(ids);
    ui.toast('กำลังอัปขึ้นระบบเบื้องหลัง — ใช้แอปต่อได้เลย');
  };

  const choose = async (m: StorageMode) => {
    if (m === s.mode) return;
    if (m === 'local') {
      await setMode('local');
      ui.toast(stats?.cloudDocs ? 'เอกสารใหม่จะเก็บในเครื่องนี้ — เอกสารที่ฝากไว้ยังอยู่บนระบบ' : 'เอกสารใหม่จะเก็บในเครื่องนี้');
      return;
    }
    if (!s.session) { setForm(true); return; }
    await enableCloud();
  };

  const pull = async (silent: boolean) => {
    setBusy('pull');
    try {
      const r = await pullFromCloud((n, t) => setProgress(t ? `${n}/${t}` : ''));
      if (r.added) ui.toast(`ดึงเอกสารที่ฝากไว้มา ${r.added} รายการ (เปิดแล้วภาพจะโหลดจากระบบ)`);
      else if (!silent) ui.toast(r.total ? 'เอกสารบนระบบอยู่ในเครื่องนี้ครบแล้ว' : 'ยังไม่มีเอกสารบนระบบ');
    } catch (e) { ui.toast(friendlyError(e), 'error'); }
    finally { setBusy(''); setProgress(''); }
  };

  const login = async () => {
    setError(''); setBusy('login');
    try {
      const sess = await cloudLogin(username.trim(), password);
      setPassword('');
      try { localStorage.setItem(USER_KEY, sess.username); } catch { /* ignore */ }
      setForm(false);
      setBusy('');
      if (s.mode !== 'cloud') await enableCloud();
      // เคยฝากไว้จากเครื่องเก่า / ก่อนล้างข้อมูลเบราว์เซอร์ = ดึงรายการกลับมาให้
      await pull(true);
    } catch (e) { setError(friendlyError(e)); }
    finally { setBusy(''); }
  };

  const allDown = async () => {
    const ids = (await db.documents.filter((d) => d.storage === 'cloud').primaryKeys()) as string[];
    if (!ids.length) return;
    if (!await ui.confirm('ดึงเอกสารทั้งหมดกลับมาเก็บในเครื่อง?',
      `${ids.length} รายการ ใช้พื้นที่ในเครื่องประมาณ ${formatBytes(stats?.cloudBytes || 0)} — ดึงครบแล้วจะลบออกจากระบบ`, { ok: 'ดึงกลับมาทั้งหมด' })) return;
    setBusy('down');
    let done = 0;
    try {
      for (const id of ids) {
        await moveToLocal(id, (n, t) => setProgress(`เอกสาร ${done + 1}/${ids.length} • ภาพ ${n}/${t}`));
        done++;
      }
      ui.toast(`เก็บในเครื่องแล้ว ${done} รายการ`);
    } catch (e) {
      ui.toast(`ดึงกลับมาแล้ว ${done}/${ids.length} รายการ — ${friendlyError(e)}`, 'error');
    } finally { setBusy(''); setProgress(''); }
  };

  const logout = async () => {
    if (stats?.cloudDocs && !await ui.confirm('ออกจากระบบที่เก็บเอกสาร?',
      `เอกสารที่ให้ระบบเก็บ ${stats.cloudDocs} รายการจะเปิดไม่ได้จนกว่าจะเข้าสู่ระบบอีกครั้ง (ไฟล์ยังอยู่บนระบบ)`, { ok: 'ออกจากระบบ', danger: true })) return;
    cloudLogout();
    if (s.mode === 'cloud') await setMode('local');
  };

  const option = (m: StorageMode, icon: React.ReactNode, title: string, desc: string) => (
    <button type="button" onClick={() => choose(m)} aria-pressed={s.mode === m}
      className={`flex items-start gap-3 rounded-xl border-2 p-3 text-left transition ${s.mode === m ? 'border-primary bg-primary/5' : 'border-line'}`}>
      <span className="mt-0.5 text-primary">{icon}</span>
      <span className="flex-1">
        <span className="block font-medium">{title}</span>
        <span className="block text-sm text-muted">{desc}</span>
      </span>
      {s.mode === m && <Check className="h-5 w-5 shrink-0 text-primary" />}
    </button>
  );

  const syncLine = s.syncing ? 'กำลังซิงก์…'
    : s.error ? s.error
      : s.pending ? `รออัปขึ้นระบบ ${s.pending} หน้า`
        : s.lastSync ? `ซิงก์ล่าสุด ${new Date(s.lastSync).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}` : '';

  return (
    <section className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <h2 className="mb-3 flex items-center gap-2 font-semibold"><HardDrive className="h-5 w-5 text-primary" />ที่เก็บเอกสาร</h2>
      <div className="grid gap-2">
        {option('local', <Smartphone className="h-5 w-5" />, 'เก็บในเครื่องนี้',
          'เปิดเร็ว ใช้ได้แม้ไม่มีอินเทอร์เน็ต แต่กินพื้นที่มือถือ')}
        {option('cloud', <Cloud className="h-5 w-5" />, 'ให้ระบบเก็บ',
          'รูปเอกสารเก็บบนระบบ ERP SHIPME มือถือเก็บแค่ภาพย่อ — เหมาะกับเครื่องที่พื้นที่เต็ม (ต้องต่ออินเทอร์เน็ตตอนเปิดเอกสาร)')}
      </div>

      {(form || (s.needLogin && !!stats?.cloudDocs)) && !busy && (
        <form className="mt-3 grid gap-2 rounded-xl bg-surface-2 p-3" onSubmit={(e) => { e.preventDefault(); login(); }}>
          <p className="text-sm">{s.session ? 'การเข้าสู่ระบบหมดอายุ — ใส่รหัส ERP อีกครั้ง' : 'ใส่ชื่อผู้ใช้และรหัสผ่าน ERP ของคุณ (ครั้งเดียว)'}</p>
          <p className="text-xs text-muted">เครื่องนี้จะจำการเข้าสู่ระบบไว้ 180 วัน ไม่จำรหัสผ่าน • เอกสารเห็นได้เฉพาะบัญชีของคุณ • เปลี่ยนรหัสผ่าน ERP = ต้องเข้าสู่ระบบใหม่</p>
          <input className={inputCls} placeholder="ชื่อผู้ใช้" autoComplete="username" autoCapitalize="none" spellCheck={false}
            value={username} onChange={(e) => setUsername(e.target.value)} />
          <input className={inputCls} placeholder="รหัสผ่าน" type="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" className="flex-1" disabled={!username.trim() || !password}><LogIn className="h-4 w-4" />เข้าสู่ระบบ</Button>
            {form && <Button type="button" variant="ghost" onClick={() => { setForm(false); setError(''); }}>ยกเลิก</Button>}
          </div>
        </form>
      )}

      {busy && (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted">
          <Spinner className="h-4 w-4 text-primary" />
          {busy === 'login' ? 'กำลังเข้าสู่ระบบ…' : busy === 'pull' ? `กำลังดึงรายการจากระบบ ${progress}` : `กำลังดึงเอกสารกลับมา ${progress}`}
        </p>
      )}

      {(s.session || !!stats?.cloudDocs) && (
        <div className="mt-3 grid gap-3 border-t border-line pt-3 text-sm">
          {s.session && <p>บัญชีที่เก็บเอกสาร: <b>{s.session.name}</b> <span className="text-muted">({s.session.username})</span></p>}
          {stats && (
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="rounded-xl bg-surface-2 p-2"><p className="font-bold">{stats.cloudDocs} <span className="font-normal text-muted">เอกสาร</span></p><p className="text-xs text-muted">บนระบบ • {formatBytes(stats.cloudBytes)}</p></div>
              <div className="rounded-xl bg-surface-2 p-2"><p className="font-bold">{stats.localDocs} <span className="font-normal text-muted">เอกสาร</span></p><p className="text-xs text-muted">ในเครื่อง • {formatBytes(stats.localBytes)}</p></div>
            </div>
          )}
          {syncLine && <p className={s.error ? 'text-amber-700 dark:text-amber-400' : 'text-muted'}>{syncLine}</p>}
          <div className="flex flex-wrap gap-2">
            {s.session && !!stats?.localDocs && <Button disabled={!!busy} onClick={moveAllUp}><CloudUpload className="h-4 w-4" />ย้ายเอกสารในเครื่องขึ้นระบบ ({stats.localDocs})</Button>}
            {s.session && <Button disabled={!!busy} onClick={() => syncNow()}><RefreshCw className="h-4 w-4" />ซิงก์ตอนนี้</Button>}
            {s.session && <Button disabled={!!busy} onClick={() => pull(false)}><CloudDownload className="h-4 w-4" />ดึงรายการจากระบบ</Button>}
            {s.session && !!stats?.cloudDocs && <Button disabled={!!busy} onClick={allDown}><Smartphone className="h-4 w-4" />ดึงทั้งหมดกลับมาเก็บในเครื่อง</Button>}
            {s.session && <Button variant="ghost" disabled={!!busy} onClick={logout}><LogOut className="h-4 w-4" />ออกจากระบบ</Button>}
          </div>
        </div>
      )}
    </section>
  );
}
