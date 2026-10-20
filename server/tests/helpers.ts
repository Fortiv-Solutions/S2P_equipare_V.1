/**
 * Test harness: boots the real API in-process on a random port with its own temporary database
 * (seeded demo data), and returns signed-in HTTP clients per persona.
 *
 *   const t = await startApp();
 *   const amit = await t.login('amit.kulkarni');   // e-mail local part of a seeded user
 *   const r = await amit.post('/api/pr/lines/17/checks');
 *   expect(r.status).toBe(200);
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

export interface Res<T = any> { status: number; body: T; headers: Headers }
export interface Client {
  get<T = any>(url: string): Promise<Res<T>>;
  post<T = any>(url: string, body?: unknown): Promise<Res<T>>;
  put<T = any>(url: string, body?: unknown): Promise<Res<T>>;
  del<T = any>(url: string): Promise<Res<T>>;
  upload<T = any>(url: string, files: { name: string; content: Buffer | string; type?: string }[], fields?: Record<string, string>): Promise<Res<T>>;
}

const DOMAINS: Record<string, string> = {
  'manoj.kale': 'hydrotech.test', 'divya.raman': 'shakti-ucg.test', sanjay: 'westernlube.test', 'pooja.malhotra': 'precisionfilt.test',
  imran: 'deccanreman.test', nitin: 'krantitools.test', 'ravi.teja': 'orionseal.test',
};
export const PASSWORD = 'Equipcare@2026';

export async function startApp(opts: { singleUser?: boolean; demoExtra?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's2p-test-'));
  process.env.S2P_DATA_DIR = dir;
  // The suite exercises the PRD's multi-user model by default; single-user mode is opt-in per test file.
  process.env.S2P_SINGLE_USER = opts.singleUser ? '1' : '0';
  // Extended demo data changes the totals the suites assert on, so it is opt-in per test file.
  process.env.S2P_DEMO_EXTRA = opts.demoExtra ? '1' : '0';
  process.env.S2P_NO_LISTEN = '1';
  process.env.S2P_NO_SCHEDULER = '1';
  const { app } = await import('../index.ts');
  const db = await import('../core/db.ts');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  function client(cookie = ''): Client & { cookie: string } {
    const c = { cookie } as Client & { cookie: string };
    const req = async (method: string, url: string, body?: unknown, form?: FormData) => {
      const res = await fetch(base + url, {
        method,
        headers: { ...(c.cookie ? { cookie: c.cookie } : {}), ...(form || body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      const set = res.headers.get('set-cookie');
      if (set) c.cookie = set.split(';')[0];
      const type = res.headers.get('content-type') ?? '';
      const data = type.includes('json') ? await res.json() : await res.text();
      return { status: res.status, body: data as any, headers: res.headers };
    };
    c.get = (u) => req('GET', u);
    c.post = (u, b) => req('POST', u, b ?? {});
    c.put = (u, b) => req('PUT', u, b ?? {});
    c.del = (u) => req('DELETE', u);
    c.upload = (u, files, fields = {}) => {
      const fd = new FormData();
      for (const f of files) fd.append('files', new Blob([typeof f.content === 'string' ? f.content : new Uint8Array(f.content)], { type: f.type ?? 'application/octet-stream' }), f.name);
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      return req('POST', u, undefined, fd);
    };
    return c;
  }

  async function login(local: string): Promise<Client> {
    // Single-user mode has no sign-in: every request is the Administrator.
    if (opts.singleUser) return client();
    const email = `${local}@${DOMAINS[local] ?? 'equipcare.test'}`;
    const c = client();
    const r = await c.post('/api/auth/login', { email, password: PASSWORD });
    if (r.status !== 200) throw new Error(`login ${email} failed: ${JSON.stringify(r.body)}`);
    if (r.body.mfaRequired) {
      const v = await c.post('/api/auth/verify-otp', { code: r.body.simulatedCode });
      if (v.status !== 200) throw new Error(`otp ${email} failed`);
    }
    return c;
  }

  return {
    base,
    db,
    anon: () => client(),
    login,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A minimal valid PDF (for upload tests). */
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
