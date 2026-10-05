'use client';
import { useEffect, useState } from 'react';
import { MAX_ORIGINAL, blobToCanvas } from '@/lib/image';
import { buildPageImages, suggestQuad } from '@/lib/process';
import { addPage } from '@/lib/repo';
import type { Quad } from '@/lib/types';
import CropEditor from './CropEditor';
import { Button, Spinner, friendlyError, useUi } from './ui';

/**
 * คิวรูป → ครอบทีละรูป → เพิ่มเป็นหน้าของเอกสาร
 * ใช้ทั้งตอนนำเข้ารูปหลายรูป และตอนถ่ายจากกล้อง (ทีละรูป)
 * แนะนำกรอบให้อัตโนมัติ แต่ไม่บังคับครอบ — กด "ใช้ภาพเต็ม" ได้เสมอ
 */
export default function CaptureFlow({ documentId, items, onDone, onCancel }: {
  documentId: string;
  items: Blob[];
  onDone: (added: number) => void;
  onCancel: () => void;
}) {
  const ui = useUi();
  const [i, setI] = useState(0);
  const [cur, setCur] = useState<{ canvas: HTMLCanvasElement; quad: Quad | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [added, setAdded] = useState(0);

  useEffect(() => {
    let alive = true;
    if (i >= items.length) { onDone(added); return; }
    setCur(null);
    (async () => {
      try {
        const canvas = await blobToCanvas(items[i], MAX_ORIGINAL);
        const s = await suggestQuad(canvas);
        if (alive) setCur({ canvas, quad: s.quad });
      } catch (e) {
        ui.toast(friendlyError(e), 'error');
        if (alive) setI((x) => x + 1);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, items]);

  const save = async (quad: Quad | null, rest = false) => {
    setSaving(true);
    try {
      const todo = rest ? items.slice(i) : [items[i]];
      for (let k = 0; k < todo.length; k++) {
        const q = k === 0 ? quad : null;      // "ใช้ภาพเต็มทั้งหมด" = รูปที่เหลือไม่ครอบ
        await addPage(documentId, await buildPageImages(todo[k], q));
        setAdded((a) => a + 1);
      }
      setI((x) => x + todo.length);
    } catch (e) {
      ui.toast(friendlyError(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (saving || !cur) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-black text-white">
        <Spinner className="h-8 w-8" />
        <p>{saving ? 'กำลังปรับภาพและบันทึก…' : `กำลังหาขอบเอกสาร… (${Math.min(i + 1, items.length)}/${items.length})`}</p>
      </div>
    );
  }
  return (
    <CropEditor
      key={i}
      source={cur.canvas}
      initial={cur.quad}
      title={items.length > 1 ? `รูป ${i + 1} / ${items.length}` : 'ปรับกรอบเอกสาร'}
      onCancel={async () => {
        if (added === 0 || await ui.confirm('หยุดนำเข้า?', `บันทึกไปแล้ว ${added} หน้า รูปที่เหลือจะไม่ถูกเพิ่ม`)) onCancel();
      }}
      onConfirm={(q) => save(q)}
      footer={items.length - i > 1 ? (
        <Button variant="ghost" className="text-white hover:bg-white/10" onClick={() => save(null, true)}>
          ใช้ภาพเต็มทั้งหมดที่เหลือ ({items.length - i})
        </Button>
      ) : null}
    />
  );
}
