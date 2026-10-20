/** Modal, drawer, confirm and reason dialogs, toasts. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, CircleAlert, Info, X, AlertTriangle } from 'lucide-react';
import { Button } from './ui';
import { Field, Textarea, ErrorSummary } from './forms';

function useEscape(onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, active]);
}

function useFocusTrap(ref: React.RefObject<HTMLElement | null>, open: boolean) {
  useEffect(() => {
    if (!open || !ref.current) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () => [...el.querySelectorAll<HTMLElement>('button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
    (el.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0])?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    };
    el.addEventListener('keydown', trap);
    return () => { el.removeEventListener('keydown', trap); prev?.focus?.(); };
  }, [open, ref]);
}

export function Modal({ open, onClose, title, sub, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(onClose, open);
  useFocusTrap(ref, open);
  if (!open) return null;
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' modal--wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={ref}>
        <div className="modal__head">
          <div>
            <h2 id="modal-title">{title}</h2>
            {sub && <p className="muted small" style={{ marginTop: 4 }}>{sub}</p>}
          </div>
          <Button variant="ghost" size="sm" iconOnly icon={<X />} onClick={onClose}>Close</Button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(onClose, open);
  useFocusTrap(ref, open);
  if (!open) return null;
  return createPortal(
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} ref={ref}>
        <div className="drawer__head">
          <h2>{title}</h2>
          <Button variant="ghost" size="sm" iconOnly icon={<X />} onClick={onClose}>Close</Button>
        </div>
        <div className="drawer__body">{children}</div>
        {footer && <div className="drawer__foot">{footer}</div>}
      </aside>
    </>,
    document.body,
  );
}

/**
 * Reason prompt used for overrides, rejections, cancellations etc. (GOV-C02).
 * Enforces the platform rule: 10–500 characters unless `minLength` says otherwise.
 */
export function ReasonDialog({
  open, onClose, onSubmit, title, sub, label = 'Reason', confirmLabel, variant = 'primary', minLength = 10, children, extraValid = true,
}: {
  open: boolean; onClose: () => void; onSubmit: (reason: string) => Promise<unknown> | unknown; title: string; sub?: ReactNode;
  label?: string; confirmLabel: string; variant?: 'primary' | 'danger' | 'decision' | 'deep' | 'ok'; minLength?: number; children?: ReactNode; extraValid?: boolean;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setReason(''); setError(null); } }, [open]);
  const tooShort = reason.trim().length < minLength;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open} onClose={onClose} title={title} sub={sub}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant={variant} onClick={submit} loading={busy} disabled={(minLength > 0 && tooShort) || !extraValid}>{confirmLabel}</Button></>}
    >
      <div className="stack">
        <ErrorSummary error={error} />
        {children}
        <Field label={label} required={minLength > 0} hint={minLength > 0 ? `At least ${minLength} characters. Recorded in the audit trail.` : 'Recorded in the audit trail.'}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} data-autofocus rows={4} />
        </Field>
      </div>
    </Modal>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, children, confirmLabel, variant = 'primary' }: { open: boolean; onClose: () => void; onConfirm: () => Promise<unknown> | unknown; title: string; children?: ReactNode; confirmLabel: string; variant?: 'primary' | 'danger' | 'deep' | 'decision' | 'ok' }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { if (open) setError(null); }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={title} footer={<><Button onClick={onClose}>Cancel</Button><Button variant={variant} loading={busy} data-autofocus onClick={async () => { setBusy(true); setError(null); try { await onConfirm(); onClose(); } catch (e) { setError(e); } finally { setBusy(false); } }}>{confirmLabel}</Button></>}>
      <div className="stack"><ErrorSummary error={error} />{children}</div>
    </Modal>
  );
}

// ---------------------------------------------------------------- toasts
type ToastTone = 'ok' | 'bad' | 'warn' | 'info';
interface ToastItem { id: number; tone: ToastTone; text: ReactNode }
const ToastCtx = createContext<(text: ReactNode, tone?: ToastTone) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: ReactNode, tone: ToastTone = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-3), { id, tone, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === 'bad' ? 9000 : 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => {
          const I = t.tone === 'ok' ? CheckCircle2 : t.tone === 'bad' ? CircleAlert : t.tone === 'warn' ? AlertTriangle : Info;
          return (
            <div key={t.id} className={`toast toast--${t.tone}`}>
              <I aria-hidden />
              <div>{t.text}</div>
              <button onClick={() => setItems((x) => x.filter((y) => y.id !== t.id))} aria-label="Dismiss"><X size={16} /></button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
