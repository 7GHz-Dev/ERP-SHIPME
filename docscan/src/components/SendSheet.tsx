'use client';
import { CheckCircle2, LogIn, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ERP_API, claimTicket, erpLogin, sendToErp, thaiDate, type ErpLogin } from '@/lib/erp';
import { DEFAULT_PDF, exportPdf } from '@/lib/pdf';
import type { DocRecord, PageRecord } from '@/lib/types';
import { Button, Sheet, friendlyError, inputCls, selectCls } from './ui';

const USER_KEY = 'docscan.erpUser';
const ERP_HOME = ERP_API.replace(/\/api\/?$/, '/');

/**
 * ส่งไปปิดบัญชี: ใส่รหัส ERP ของตัวเอง → เลือกใบเบิก → แนบ PDF เป็นหลักฐานการตรวจปล่อยของใบนั้น
 * ต้องใส่รหัสทุกครั้งที่เปิด (ปิดแผ่นนี้ = ล้างการเข้าสู่ระบบ) • จำแค่ชื่อผู้ใช้ไว้ให้ ไม่จำรหัสผ่าน
 */
export default function SendSheet({ open, onClose, doc, pages }: {
  open: boolean; onClose: () => void; doc: DocRecord; pages: PageRecord[];
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [login, setLogin] = useState<ErpLogin | null>(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ date: string; files: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    try { setUsername(localStorage.getItem(USER_KEY) || ''); } catch { /* โหมดส่วนตัว */ }
  }, [open]);

  const close = () => {
    setPassword(''); setLogin(null); setPick(''); setError(''); setDone(null); setBusy('');
    onClose();
  };

  const doLogin = async () => {
    setError(''); setBusy('login');
    try {
      const r = await erpLogin(username.trim(), password);
      setPassword('');
      try { localStorage.setItem(USER_KEY, r.username); } catch { /* ignore */ }
      setLogin(r);
      // ค่าเริ่มต้น: ใบเบิกล่าสุดที่ยังไม่ปิดบัญชี
      setPick((r.claims.find((c) => !c.settled) || r.claims[0])?.inspectDate || '');
    } catch (e) {
      setError(friendlyError(e));
    } finally { setBusy(''); }
  };

  const doSend = async () => {
    const c = login?.claims.find((x) => x.inspectDate === pick);
    if (!login || !c) return;
    setError(''); setBusy('send');
    try {
      const pdf = await exportPdf(pages, { ...DEFAULT_PDF, quality: 'medium', compression: 'balanced', dpi: 150 }, doc.name);
      await sendToErp(claimTicket(login, c), pdf, { name: `${doc.name}.pdf`, pages: pages.length });
      setDone({ date: c.inspectDate, files: c.files + 1 });
    } catch (e) {
      setError(friendlyError(e));
    } finally { setBusy(''); }
  };

  const label = (c: ErpLogin['claims'][number]) =>
    [`ตรวจปล่อย ${thaiDate(c.inspectDate)}`, `${c.containers} ตู้`, `${c.total.toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท`,
      c.settled ? 'ปิดบัญชีแล้ว' : '', c.files ? `มีไฟล์แล้ว ${c.files}` : ''].filter(Boolean).join(' • ');

  return (
    <Sheet open={open} onClose={close} title="ส่งไปปิดบัญชี">
      {done ? (
        <div className="grid gap-3 text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
          <p className="font-semibold">แนบไฟล์แล้ว</p>
          <p className="text-sm text-muted">ใบเบิกวันที่ตรวจปล่อย {thaiDate(done.date)} — มีไฟล์หลักฐาน {done.files} ไฟล์<br />ไปทำใบปิดบัญชีต่อใน ERP ได้เลย</p>
          <Button variant="primary" onClick={close}>ปิด</Button>
          <a href={ERP_HOME} target="_blank" rel="noopener" className="text-sm text-primary underline">เปิด ERP</a>
        </div>
      ) : !login ? (
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); doLogin(); }}>
          <p className="text-sm text-muted">ใส่ชื่อผู้ใช้และรหัสผ่านที่ใช้เข้า ERP ของคุณ เพื่อเลือกใบเบิกที่จะแนบไฟล์นี้</p>
          <input className={inputCls} placeholder="ชื่อผู้ใช้" autoComplete="username" autoCapitalize="none" spellCheck={false}
            value={username} onChange={(e) => setUsername(e.target.value)} />
          <input className={inputCls} placeholder="รหัสผ่าน" type="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" variant="primary" loading={busy === 'login'} disabled={!username.trim() || !password}>
            <LogIn className="h-4 w-4" />เข้าสู่ระบบ
          </Button>
        </form>
      ) : (
        <div className="grid gap-3">
          <p className="text-sm">ผู้ใช้: <b>{login.name}</b></p>
          {login.claims.length ? (
            <>
              <label className="grid gap-1 text-sm">
                <span className="text-muted">เลือกใบเบิกที่จะแนบไฟล์</span>
                <select className={`${selectCls} w-full`} value={pick} onChange={(e) => setPick(e.target.value)}>
                  {login.claims.map((c) => <option key={c.inspectDate} value={c.inspectDate}>{label(c)}</option>)}
                </select>
              </label>
              <p className="rounded-xl bg-surface-2 p-3 text-sm">ไฟล์ที่จะแนบ: <b>{doc.name}.pdf</b> • {pages.length} หน้า</p>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button variant="primary" loading={busy === 'send'} disabled={!pick || !pages.length} onClick={doSend}>
                <Send className="h-4 w-4" />แนบไฟล์เข้าใบปิดบัญชี
              </Button>
            </>
          ) : (
            <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
              ยังไม่มีใบเบิกในระบบ — ทำใบเบิกใน ERP ก่อน แล้วค่อยกลับมาส่งไฟล์
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}
