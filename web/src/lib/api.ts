/** Thin fetch wrapper. Errors carry the server's message and per-field errors. */
export class ApiError extends Error {
  status: number;
  code: string;
  fields?: Record<string, string>;
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function qs(q?: Query) {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${url}`, {
      method,
      credentials: 'same-origin',
      headers: body instanceof FormData ? undefined : body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', 'The server could not be reached. Check your connection and try again.');
  }
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('application/json') ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const e = data?.error;
    if (res.status === 401 && e?.code === 'unauthenticated') window.dispatchEvent(new CustomEvent('s2p:unauthenticated'));
    // Another tab switched this browser between the administrator workspace and a vendor portal view.
    if (e?.code === 'wrong_workspace') window.dispatchEvent(new CustomEvent('s2p:workspace-changed'));
    throw new ApiError(res.status, e?.code ?? 'http_error', e?.message ?? `Request failed (${res.status}).`, e?.fields);
  }
  return data as T;
}

export const api = {
  get: <T = any>(url: string, q?: Query) => request<T>('GET', url + qs(q)),
  post: <T = any>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T = any>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  patch: <T = any>(url: string, body?: unknown) => request<T>('PATCH', url, body ?? {}),
  del: <T = any>(url: string) => request<T>('DELETE', url),
  upload: <T = any>(url: string, form: FormData) => request<T>('POST', url, form),
};

/** URL for a server-generated download (CSV/PDF) — opened in a new tab or as a link. */
export const downloadUrl = (url: string, q?: Query) => `/api${url}${qs(q)}`;
