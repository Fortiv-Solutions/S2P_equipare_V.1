import type { NextFunction, Request, Response, RequestHandler } from 'express';
import { z, ZodError, type ZodType } from 'zod';

export class HttpError extends Error {
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

export const badRequest = (message: string, fields?: Record<string, string>) =>
  new HttpError(400, 'validation_failed', message, fields);
export const forbidden = (message = 'You do not have permission to do this.') => new HttpError(403, 'forbidden', message);
export const notFound = (what = 'Record') => new HttpError(404, 'not_found', `${what} not found.`);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);

/** Express 5 forwards rejected promises itself; this keeps handler typing tidy. */
export const h =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler =>
  async (req, res, next) => {
    try {
      const out = await fn(req, res, next);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      next(e);
    }
  };

/** Parse and validate input with zod; throws a 400 naming each failing field. */
export function parse<T extends ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw zodToHttp(r.error);
  return r.data;
}

export function zodToHttp(err: ZodError) {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  const first = Object.entries(fields)[0];
  return badRequest(first ? `${humanize(first[0])}: ${first[1]}` : 'Invalid input.', fields);
}

function humanize(path: string) {
  return path.replace(/_/g, ' ').replace(/\./g, ' › ');
}

/** Require a non-trivial reason (GOV-C02 / PRD reason rules: 10 to 500 characters). */
export const reasonSchema = z
  .string({ error: 'Reason is required' })
  .trim()
  .min(10, 'Reason must be at least 10 characters')
  .max(500, 'Reason must be 500 characters or fewer');

export const idParam = (req: Request, name = 'id') => {
  const v = Number(req.params[name]);
  if (!Number.isInteger(v) || v <= 0) throw badRequest(`Invalid ${name}.`);
  return v;
};

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) err = zodToHttp(err);
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, fields: err.fields } });
    return;
  }
  const e = err as { type?: string; code?: string; message?: string };
  if (e?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: { code: 'file_too_large', message: 'File exceeds the size limit.' } });
    return;
  }
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_json', message: 'Request body is not valid JSON.' } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'server_error', message: 'Something failed on the server. The error has been logged.' } });
}

/** CSV export helper (opens in Excel). */
export function sendCsv(res: Response, filename: string, rows: Record<string, unknown>[], columns?: { key: string; label: string }[]) {
  const cols = columns ?? Object.keys(rows[0] ?? {}).map((k) => ({ key: k, label: k }));
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    // Guard against CSV formula injection in spreadsheet apps.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const body = [cols.map((c) => esc(c.label)).join(','), ...rows.map((r) => cols.map((c) => esc(r[c.key])).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + body);
}
