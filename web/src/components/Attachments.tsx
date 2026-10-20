/** File upload (drag & drop, file picker, phone camera) and attachment lists (FR-PLT-07, FR-DSP-06). */
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Download, FileText, Paperclip, ShieldCheck, ShieldAlert, UploadCloud, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Button, Empty, LoadingBlock } from './ui';
import { useToast } from './overlay';

export interface Uploaded { id: number; filename: string; mime: string; size: number; scan_status: string; scan_note: string }

const kb = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * Uploads immediately and reports stored file ids. Pass ownerType/ownerId to attach to an existing
 * record, or collect ids and send them with the form that creates the record.
 */
export function FileDrop({ ownerType, ownerId, label, onUploaded, accept, camera, multiple = true, vendorVisible = true, compact }: {
  ownerType?: string; ownerId?: number; label?: string; onUploaded?: (files: Uploaded[]) => void; accept?: string; camera?: boolean; multiple?: boolean; vendorVisible?: boolean; compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const cam = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Uploaded[]>([]);
  const toast = useToast();
  const qc = useQueryClient();

  const send = async (files: FileList | File[] | null) => {
    if (!files || !files.length) return;
    setBusy(true);
    setError(null);
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append('files', f);
    if (ownerType) fd.append('owner_type', ownerType);
    if (ownerId) fd.append('owner_id', String(ownerId));
    if (label) fd.append('label', label);
    if (!vendorVisible) fd.append('vendor_visible', '0');
    try {
      const r = await api.upload<{ files: Uploaded[]; errors: string[] }>('/files', fd);
      const next = [...done, ...r.files];
      setDone(next);
      onUploaded?.(next);
      if (r.errors.length) setError(r.errors.join(' '));
      toast(`${r.files.length} file${r.files.length === 1 ? '' : 's'} uploaded`);
      if (ownerType && ownerId) qc.invalidateQueries({ queryKey: ['files', ownerType, ownerId] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Upload failed. Check your connection and try again.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
      if (cam.current) cam.current.value = '';
    }
  };

  return (
    <div className="stack-sm">
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); send(e.dataTransfer.files); }}
        style={{ border: `1.5px dashed ${drag ? 'var(--primary-600)' : 'var(--line-strong)'}`, background: drag ? 'var(--primary-50)' : 'var(--surface-sunk)', borderRadius: 'var(--r-md)', padding: compact ? 12 : 18, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}
      >
        <UploadCloud size={22} color="var(--primary-600)" aria-hidden />
        <div className="grow small muted">{label ? <strong style={{ color: 'var(--text)' }}>{label}. </strong> : null}Drop files here, or choose them. PDF, images, Office files.</div>
        <input ref={input} type="file" hidden multiple={multiple} accept={accept} onChange={(e) => send(e.target.files)} />
        <Button size="sm" icon={<Paperclip />} loading={busy} onClick={() => input.current?.click()}>Choose files</Button>
        {camera && (
          <>
            <input ref={cam} type="file" hidden accept="image/*" capture="environment" onChange={(e) => send(e.target.files)} />
            <Button size="sm" variant="deep" icon={<Camera />} onClick={() => cam.current?.click()} disabled={busy}>Take photo</Button>
          </>
        )}
      </div>
      {error && <div className="field__error" role="alert">{error}</div>}
      {!ownerId && done.length > 0 && (
        <ul className="list-plain stack-sm">
          {done.map((f) => (
            <li key={f.id} className="row small">
              <FileText size={14} aria-hidden /> <span className="grow">{f.filename}</span> <span className="subtle">{kb(f.size)}</span>
              <Button size="sm" variant="ghost" iconOnly icon={<X />} onClick={() => { const next = done.filter((x) => x.id !== f.id); setDone(next); onUploaded?.(next); }}>Remove {f.filename}</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AttachmentList({ ownerType, ownerId, canUpload, uploadLabel, camera, vendorVisible }: { ownerType: string; ownerId: number; canUpload?: boolean; uploadLabel?: string; camera?: boolean; vendorVisible?: boolean }) {
  const q = useQuery<{ id: number; label: string | null; filename: string; mime: string; size: number; scan_status: string; scan_note: string; created_at: string; uploaded_by_name: string | null }[]>({
    queryKey: ['files', ownerType, ownerId],
    queryFn: () => api.get('/files', { owner_type: ownerType, owner_id: ownerId }),
  });
  return (
    <div className="stack">
      {q.isLoading ? <LoadingBlock rows={2} /> : !q.data?.length ? (
        <Empty title="No documents yet" icon={<Paperclip size={22} />}>{canUpload ? 'Upload supporting documents below.' : 'Documents will appear here when added.'}</Empty>
      ) : (
        <ul className="list-plain stack-sm">
          {q.data.map((f) => (
            <li key={f.id} className="row" style={{ padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)' }}>
              <FileText size={16} color="var(--primary-600)" aria-hidden />
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.label ? `${f.label} — ` : ''}{f.filename}</div>
                <div className="small subtle">{kb(f.size)} · {f.uploaded_by_name ?? 'System'} · {fmtDateTime(f.created_at)}</div>
              </div>
              <span title={f.scan_note} className="small" style={{ color: f.scan_status === 'Available' ? 'var(--ok)' : 'var(--bad)', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                {f.scan_status === 'Available' ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />}
                <span className="desktop-only">{f.scan_status === 'Available' ? 'Checked' : f.scan_status}</span>
              </span>
              {f.scan_status === 'Available' && (
                <a className="btn btn--ghost btn--sm" href={`/api/files/${f.id}/download`} target="_blank" rel="noreferrer"><Download size={14} /> <span className="desktop-only">Download</span></a>
              )}
            </li>
          ))}
        </ul>
      )}
      {canUpload && <FileDrop ownerType={ownerType} ownerId={ownerId} label={uploadLabel} camera={camera} vendorVisible={vendorVisible} compact />}
    </div>
  );
}
