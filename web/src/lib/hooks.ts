import { useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useToast } from '@/components/overlay';
import { ApiError } from './api';

/**
 * Run a server action with busy state, success toast and cache invalidation.
 * Errors are toasted and also kept so forms can show field errors.
 */
export function useAction<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  opts: { success?: string | ((r: R) => string); invalidate?: QueryKey[]; onSuccess?: (r: R) => void; silentError?: boolean } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (...args: A): Promise<R> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn(...args);
      for (const k of opts.invalidate ?? []) await qc.invalidateQueries({ queryKey: k });
      if (opts.success) toast(typeof opts.success === 'function' ? opts.success(r) : opts.success, 'ok');
      opts.onSuccess?.(r);
      return r;
    } catch (e) {
      setError(e);
      if (!opts.silentError) toast(e instanceof ApiError ? e.message : 'The action failed.', 'bad');
      throw e;
    } finally {
      setBusy(false);
    }
  };
  /** Same as run but swallows the error (already toasted). */
  const fire = (...args: A) => run(...args).catch(() => undefined);
  return { run, fire, busy, error, reset: () => setError(null) };
}
