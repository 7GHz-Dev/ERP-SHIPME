'use client';
import { X, Loader2 } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

/** ชุด UI พื้นฐาน (สไตล์ shadcn) — ปุ่มใหญ่กดง่ายบนมือถือ (สูงอย่างน้อย 44px) */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANT: Record<Variant, string> = {
  primary: 'bg-primary text-white hover:bg-primary/90 shadow-sm',
  secondary: 'bg-surface-2 text-fg hover:bg-surface-3 border border-line',
  ghost: 'text-fg hover:bg-surface-2',
  danger: 'bg-red-600 text-white hover:bg-red-700'
};
export function Button({ variant = 'secondary', className = '', loading, children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button {...rest} disabled={rest.disabled || loading}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-[15px] font-medium transition disabled:opacity-50 ${VARIANT[variant]} ${className}`}>
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}{children}
    </button>
  );
}
export function IconButton({ label, className = '', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button {...rest} aria-label={label} title={label}
      className={`inline-flex h-11 min-w-11 items-center justify-center rounded-xl text-fg transition hover:bg-surface-2 disabled:opacity-40 ${className}`}>
      {children}
    </button>
  );
}
export const Spinner = ({ className = '' }: { className?: string }) => <Loader2 className={`animate-spin ${className}`} />;

/** Bottom sheet บนมือถือ / กล่องกลางจอบนเดสก์ท็อป */
export function Sheet({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title?: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className={`max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-xl sm:rounded-2xl ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'}`}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{title}</h2>
          <IconButton label="ปิด" onClick={onClose}><X className="h-5 w-5" /></IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Slider({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <div className="mb-1 flex justify-between text-sm text-muted"><span>{label}</span><span className="tabular-nums">{value}</span></div>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="h-8 w-full accent-[var(--primary)]" />
    </label>
  );
}

const fieldBase = 'min-h-11 rounded-xl border border-line bg-surface px-3 text-[15px] outline-none focus:border-primary';
export const inputCls = `${fieldBase} w-full`;
/** select ไม่บังคับเต็มความกว้าง — ใส่ w-full เองเมื่อต้องการ */
export const selectCls = fieldBase;

// ---------- toast + dialog (confirm / prompt) ----------
type Toast = { id: number; text: string; kind: 'info' | 'error' };
interface DialogReq { title: string; message?: string; input?: string; ok?: string; danger?: boolean; resolve: (v: string | boolean | null) => void }
interface UiApi {
  toast: (text: string, kind?: 'info' | 'error') => void;
  confirm: (title: string, message?: string, opts?: { ok?: string; danger?: boolean }) => Promise<boolean>;
  prompt: (title: string, value?: string) => Promise<string | null>;
}
const UiCtx = createContext<UiApi | null>(null);
export const useUi = () => {
  const v = useContext(UiCtx);
  if (!v) throw new Error('UiProvider missing');
  return v;
};

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dlg, setDlg] = useState<DialogReq | null>(null);
  const [text, setText] = useState('');
  const seq = useRef(0);
  const toast = useCallback((t: string, kind: 'info' | 'error' = 'info') => {
    const id = ++seq.current;
    setToasts((x) => [...x, { id, text: t, kind }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), kind === 'error' ? 5000 : 2800);
  }, []);
  const confirm = useCallback((title: string, message?: string, o?: { ok?: string; danger?: boolean }) =>
    new Promise<boolean>((resolve) => setDlg({ title, message, ok: o?.ok, danger: o?.danger, resolve: (v) => resolve(Boolean(v)) })), []);
  const prompt = useCallback((title: string, value = '') => new Promise<string | null>((resolve) => {
    setText(value);
    setDlg({ title, input: value, resolve: (v) => resolve(typeof v === 'string' ? v : null) });
  }), []);
  const close = (v: string | boolean | null) => { dlg?.resolve(v); setDlg(null); };
  return (
    <UiCtx.Provider value={{ toast, confirm, prompt }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[70] flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div key={t.id} role="status"
            className={`pointer-events-auto max-w-md rounded-xl px-4 py-3 text-sm text-white shadow-lg ${t.kind === 'error' ? 'bg-red-600' : 'bg-slate-900'}`}>{t.text}</div>
        ))}
      </div>
      {dlg && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" onClick={() => close(dlg.input !== undefined ? null : false)}>
          <form className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); close(dlg.input !== undefined ? text : true); }}>
            <h3 className="text-lg font-semibold">{dlg.title}</h3>
            {dlg.message && <p className="mt-2 text-sm text-muted">{dlg.message}</p>}
            {dlg.input !== undefined && (
              <input autoFocus className={`${inputCls} mt-3`} value={text} onChange={(e) => setText(e.target.value)} maxLength={120} />
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => close(dlg.input !== undefined ? null : false)}>ยกเลิก</Button>
              <Button type="submit" variant={dlg.danger ? 'danger' : 'primary'}>{dlg.ok || 'ตกลง'}</Button>
            </div>
          </form>
        </div>
      )}
    </UiCtx.Provider>
  );
}

/** ข้อความ error ที่ผู้ใช้อ่านเข้าใจ — ไม่โชว์ stack trace */
export function friendlyError(e: unknown) {
  const m = e instanceof Error ? e.message : String(e);
  if (/QuotaExceeded|quota/i.test(m)) return 'พื้นที่เก็บในเครื่องเต็ม — ลบเอกสารที่ไม่ใช้หรือล้างถังขยะก่อน';
  if (/NotAllowedError|Permission/i.test(m)) return 'ไม่ได้รับอนุญาตให้ใช้กล้อง — เปิดสิทธิ์กล้องในการตั้งค่าเบราว์เซอร์';
  if (/NotFoundError|DevicesNotFound/i.test(m)) return 'ไม่พบกล้องในอุปกรณ์นี้ — ใช้ "นำเข้ารูป" แทน';
  if (/^[A-Za-z]+Error:|at .*\(/.test(m) || m.length > 200) return 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง';
  return m || 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง';
}

/** แปลง Blob เป็น object URL แล้วคืนให้อัตโนมัติเมื่อเลิกใช้ */
export function useBlobUrl(blob: Blob | null | undefined) {
  const [url, setUrl] = useState<string>('');
  useEffect(() => {
    if (!blob) { setUrl(''); return; }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}
