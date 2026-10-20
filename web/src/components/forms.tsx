import { cloneElement, isValidElement, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { useUid } from './ui';
import { ApiError } from '@/lib/api';

/** Labelled field. Labels are always visible; errors and hints are tied to the control for screen readers. */
export function Field({ label, hint, error, required, children, className = '' }: { label: ReactNode; hint?: ReactNode; error?: string | null; required?: boolean; children: ReactElement<any>; className?: string }) {
  const id = useUid('f');
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined;
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, { id: (children.props as any).id ?? id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy, 'aria-required': required || undefined })
    : children;
  return (
    <div className={`field ${className}`}>
      <label className="field__label" htmlFor={(children.props as any).id ?? id}>
        {label}
        {required && <span className="field__req" aria-hidden>*</span>}
      </label>
      {control}
      {hint && !error && <span className="field__hint" id={`${id}-hint`}>{hint}</span>}
      {error && <span className="field__error" id={`${id}-err`}>{error}</span>}
    </div>
  );
}

export function Input({ className = '', ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input ${className}`} {...p} />;
}
export function Textarea({ className = '', ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`textarea ${className}`} {...p} />;
}
export function Select({ className = '', options, placeholder, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { options: (string | { value: string | number; label: string })[]; placeholder?: string }) {
  return (
    <select className={`select ${className}`} {...p}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) =>
        typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>,
      )}
    </select>
  );
}
export function Checkbox({ label, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" {...p} />
      <span>{label}</span>
    </label>
  );
}

/** Error summary at the top of a form (PRD 10.1 forms). */
export function ErrorSummary({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  const fields = e instanceof ApiError && e.fields ? Object.entries(e.fields) : [];
  return (
    <div className="error-summary" role="alert">
      <strong>{e.message ?? 'Check the form and try again.'}</strong>
      {fields.length > 1 && (
        <ul>
          {fields.map(([k, v]) => <li key={k}>{k.replace(/_/g, ' ')}: {v}</li>)}
        </ul>
      )}
    </div>
  );
}

/** Field error from an ApiError, by field name. */
export const fieldError = (error: unknown, name: string) => (error instanceof ApiError ? error.fields?.[name] ?? null : null);
