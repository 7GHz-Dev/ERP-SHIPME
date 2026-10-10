'use client';
import { useEffect, useState } from 'react';
import { pinDoc } from '@/lib/cloud';
import { MAX_ORIGINAL, blobToCanvas } from '@/lib/image';
import { buildPageFromCanvas, buildPageImages, suggestQuad } from '@/lib/process';
import { addPage } from '@/lib/repo';
import type { Quad } from '@/lib/types';
import CropEditor from './CropEditor';
import { Button, Spinner, friendlyError, useUi } from './ui';

/**
 * คิวรูป → (ยืนยันกรอบทีละรูป หรือครอบอัตโนมัติทั้งหมด) → เพิ่มเป็นหน้าของเอกสาร
 * ใช้ตอนนำเข้ารูปหลายรูป (จากแกลเลอรี/ไฟล์)
 * - confirm = false: หาขอบแล้วครอบให้เลยทุกรูป (หาไม่เจอ = ใช้ภาพเต็ม) แก้ทีหลังได้ด้วยปุ่ม "ครอบ"
 * - confirm = true : แนะนำกรอบให้ แล้วให้ปรับ/ยืนยันทีละรูป กด "ใช้ภาพเต็ม" ได้เสมอ
 */
export default function CaptureFlow({ documentId, items, confirm = true, onDone, onCancel }: {
  documentId: string;
  items: Blob[];
  confirm?: boolean;
  onDone: (added: number) => void;
  onCancel: () => void;
}) {
  const ui = useUi();
  const [i, setI] = useState(0);
  const [cur, setCur] = useState<{ canvas: HTMLCanvasElement; quad: Quad | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [added, setAdded] = useState(0);

  // ระหว่างนำเข้า ห้ามลบรูปของเอกสารนี้ออกจากเครื่อง (โหมดให้ระบบเก็บ)
  useEffect(() => pinDoc(documentId), [documentId]);

  useEffect(() => {
    let alive = true;
    if (i >= items.length) { onDone(added); return; }
    setCur(null);
    (async () => {
      try {
        const canvas = await blobToCanvas(items[i], MAX_ORIGINAL);
        const s = await suggestQuad(canvas);
        if (!alive) return;
        if (confirm) { setCur({ canvas, quad: s.quad }); return; }
        // ไม่ต้องยืนยัน: ครอบตามที่หาได้แล้วไปรูปถัดไปเลย
        await addPage(documentId, await buildPageFromCanvas(canvas, s.quad));
        if (!alive) return;
        setAdded((a) => a + 1);
        setI((x) => x + 1);
      } catch (e) {
        ui.toast(friendlyError(e), 'error');
        if (alive) setI((x) => x + 1);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, items]);

  const save = async (quad: Quad | null, rest = false) => {
    if (!cur) return;
    setSaving(true);
    try {
      await addPage(documentId, await buildPageFromCanvas(cur.canvas, quad));
      setAdded((a) => a + 1);
      // "ใช้ภาพเต็มทั้งหมดที่เหลือ" = รูปที่เหลือไม่ครอบ
      const others = rest ? items.slice(i + 1) : [];
      for (const b of others) { await addPage(documentId, await buildPageImages(b, null)); setAdded((a) => a + 1); }
      setI((x) => x + 1 + others.length);
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
        <p>{saving ? 'กำลังปรับภาพและบันทึก…' : `${confirm ? 'กำลังหาขอบเอกสาร' : 'กำลังครอบและปรับภาพ'}… (${Math.min(i + 1, items.length)}/${items.length})`}</p>
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
