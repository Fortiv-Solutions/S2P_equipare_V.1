/**
 * Attachments (FR-PLT-07, NFR-DOC-01, NFR-SEC-07).
 *  - Type is checked from file content (magic bytes), not the file name.
 *  - Size limit and allowed types come from configuration.
 *  - Malware scan: only a signature check for the EICAR test string is performed. No antivirus
 *    engine is connected; the scan note says so on every file.
 *  - Downloads go through permission checks registered by the owning module.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { FILES_DIR, get, insert, now, run } from './db.ts';
import { cfg } from './config.ts';
import { badRequest } from './http.ts';
import type { Actor } from './auth.ts';

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 10 } });

const SIGS: { ext: string; mime: string; test: (b: Buffer) => boolean }[] = [
  { ext: 'pdf', mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString() === '%PDF-' },
  { ext: 'png', mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
  { ext: 'zip-office', mime: 'application/zip', test: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
  { ext: 'ole-office', mime: 'application/x-ole-storage', test: (b) => b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) },
];

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

function detect(buf: Buffer, filename: string): { ext: string; mime: string } | null {
  const nameExt = path.extname(filename).slice(1).toLowerCase();
  for (const s of SIGS) {
    if (!s.test(buf)) continue;
    if (s.ext === 'zip-office') {
      if (nameExt === 'docx') return { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
      if (nameExt === 'xlsx') return { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
      return null;
    }
    if (s.ext === 'ole-office') {
      if (nameExt === 'doc') return { ext: 'doc', mime: 'application/msword' };
      if (nameExt === 'xls') return { ext: 'xls', mime: 'application/vnd.ms-excel' };
      return null;
    }
    return { ext: s.ext === 'jpg' ? 'jpg' : s.ext, mime: s.mime };
  }
  // Plain text (csv/txt): no NUL bytes in the first 8 KB.
  if ((nameExt === 'csv' || nameExt === 'txt') && !buf.subarray(0, 8192).includes(0)) {
    return { ext: nameExt, mime: nameExt === 'csv' ? 'text/csv' : 'text/plain' };
  }
  return null;
}

export interface StoredFile {
  id: number;
  filename: string;
  mime: string;
  size: number;
  scan_status: string;
  scan_note: string;
}

/** Validate, scan and store an uploaded file. Throws 400 with a reason the user can act on. */
export function storeFile(
  file: Express.Multer.File,
  actor: Actor | null,
  opts: { ownerType?: string; ownerId?: number | null; label?: string; vendorVisible?: boolean; restricted?: boolean } = {},
): StoredFile {
  const limits = cfg<{ max_mb: number; types: string[] }>('files.limits');
  if (file.size > limits.max_mb * 1024 * 1024) throw badRequest(`${file.originalname} is larger than the ${limits.max_mb} MB limit.`);
  if (file.size === 0) throw badRequest(`${file.originalname} is empty.`);
  const kind = detect(file.buffer, file.originalname);
  if (!kind || !limits.types.includes(kind.ext)) {
    throw badRequest(`${file.originalname} is not an allowed file type. Allowed: ${limits.types.join(', ')}.`);
  }
  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const infected = file.buffer.includes(Buffer.from(EICAR));
  const scan_status = infected ? 'Quarantined' : 'Available';
  const scan_note = infected
    ? 'EICAR test signature found — file quarantined and not available for download.'
    : 'Signature check passed (EICAR only). No antivirus engine is connected — simulated scan.';
  const safeName = path.basename(file.originalname).replace(/[^\w.\- ()]/g, '_').slice(0, 120);
  const id = insert('attachments', {
    owner_type: opts.ownerType ?? null, owner_id: opts.ownerId ?? null, label: opts.label ?? null,
    filename: safeName, mime: kind.mime, size: file.size, sha256, storage_path: '', scan_status, scan_note,
    vendor_visible: opts.vendorVisible === false ? 0 : 1, restricted: opts.restricted ? 1 : 0,
    uploaded_by: actor?.id ?? null, created_at: now(),
  });
  if (!infected) {
    const dir = path.join(FILES_DIR, sha256.slice(0, 2));
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${id}-${sha256.slice(0, 16)}.${kind.ext}`);
    fs.writeFileSync(p, file.buffer);
    run('UPDATE attachments SET storage_path = ? WHERE id = ?', path.relative(FILES_DIR, p), id);
  }
  if (infected) throw badRequest(`${safeName} failed the malware check and was quarantined.`);
  return { id, filename: safeName, mime: kind.mime, size: file.size, scan_status, scan_note };
}

/** Store a server-generated file (e.g. a PDF document). */
export function storeGenerated(buf: Buffer, filename: string, mime: string, opts: { ownerType: string; ownerId: number; label?: string; actorId?: number | null; vendorVisible?: boolean }) {
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const id = insert('attachments', {
    owner_type: opts.ownerType, owner_id: opts.ownerId, label: opts.label ?? null, filename, mime, size: buf.length, sha256,
    storage_path: '', scan_status: 'Available', scan_note: 'Generated by the platform.',
    vendor_visible: opts.vendorVisible === false ? 0 : 1, restricted: 0, uploaded_by: opts.actorId ?? null, created_at: now(),
  });
  const dir = path.join(FILES_DIR, sha256.slice(0, 2));
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${id}-${sha256.slice(0, 16)}${path.extname(filename)}`);
  fs.writeFileSync(p, buf);
  run('UPDATE attachments SET storage_path = ? WHERE id = ?', path.relative(FILES_DIR, p), id);
  return id;
}

export function linkAttachments(ids: number[], ownerType: string, ownerId: number) {
  for (const id of ids) run('UPDATE attachments SET owner_type = ?, owner_id = ? WHERE id = ? AND (owner_id IS NULL OR owner_type = ?)', ownerType, ownerId, id, ownerType);
}

export function filePath(att: { storage_path: string }) {
  return path.join(FILES_DIR, att.storage_path);
}

/** Modules register who may read files attached to their objects. */
type AccessFn = (actor: Actor, ownerId: number) => boolean;
const access = new Map<string, AccessFn>();
export function registerFileAccess(ownerType: string, fn: AccessFn) {
  access.set(ownerType, fn);
}
/** Same registry guards comment threads and other per-object reads. */
export const registerObjectAccess = registerFileAccess;
export function canAccessObject(actor: Actor, ownerType: string, ownerId: number) {
  const fn = access.get(ownerType);
  return fn ? fn(actor, ownerId) : actor.role !== 'VEN';
}

export function canReadFile(actor: Actor, att: { owner_type: string | null; owner_id: number | null; uploaded_by: number | null; vendor_visible: number }) {
  if (att.uploaded_by === actor.id) return true;
  if (actor.role === 'VEN' && !att.vendor_visible) return false;
  if (!att.owner_type || att.owner_id == null) return false;
  const fn = access.get(att.owner_type);
  return fn ? fn(actor, att.owner_id) : actor.role !== 'VEN';
}

export function getAttachment(id: number) {
  return get<{ id: number; owner_type: string | null; owner_id: number | null; filename: string; mime: string; size: number; storage_path: string; scan_status: string; uploaded_by: number | null; vendor_visible: number; restricted: number }>(
    'SELECT * FROM attachments WHERE id = ?', id,
  );
}
