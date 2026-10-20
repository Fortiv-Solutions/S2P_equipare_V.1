# Equipcare S2P — engineering guide

Source of truth for requirements: the PRD (Knowteq Equipcare LLP Source-to-Pay PRD, Draft 1.0). Every
requirement keeps its PRD id (PR-01, FR-RFQ-03, AC-INV-06 …) in code comments, tests and screen ids.

## Stack and commands

| Part | Tech |
| --- | --- |
| API | Node 24, Express 5, TypeScript run by `tsx`, Zod 4 validation, `node:sqlite` persistence (`data/s2p.db`) |
| Web | Vite 8, React 19, React Router 7, TanStack Query 5, lucide-react icons, plain CSS design tokens |
| Tests | Vitest (`server/tests/*.test.ts`), Python Playwright screenshots (`scripts/shot.py`) |

```
npm run dev:api            # API on :4000 (PORT env overrides)
npm run dev:web            # Web on :5173, proxies /api to :$S2P_API_PORT (default 4000)
npm run seed               # wipe data/ and re-seed demo data
npx tsc -p server/tsconfig.json ; npx tsc -p web/tsconfig.json
npx vitest run server/tests/<file>.test.ts     # run from PowerShell (Git Bash breaks vitest's drive-letter check)
```

Parallel work: give your own API instance its own port and data dir so you never disturb others:
`$env:PORT=41xx; $env:S2P_DATA_DIR='data/agent-<name>'; npx tsx server/index.ts` and
`$env:S2P_API_PORT=41xx; npx vite --config web/vite.config.ts --port 51xx --strictPort`.
Delete your data dir to re-seed after changing seed code. Screenshots:
`$env:SHOT_BASE='http://localhost:51xx'; python scripts/shot.py <email> <outdir> /path1,/path2 [width]`
(in Git Bash set `MSYS_NO_PATHCONV=1`). Run long-lived servers as background tasks.

## Non-negotiable product rules (PRD)

- **SAP is the system of record.** The platform never creates POs, GRNs, invoice postings or payments
  itself. In this MVP a **SAP simulator** (`sap_documents`) stands in for SAP; simulator actions write SAP
  documents and inbound sync copies them into platform tables. Business code must not write SAP-owned
  copies (`vendors` master fields, `materials`, `pr_lines` SAP fields, `pos`, `po_lines` SAP fields, `grns`,
  invoice SAP status fields, `contracts` SAP fields) except through the sync mappers in `core/sap.ts`.
- **Never fabricate an external success.** Anything simulated (SAP, OCR, e-mail/SMS/WhatsApp, AI) is
  labelled in the UI with `<SimBadge>` / `.sim-panel`. E-mail goes to the simulated outbox via `notify()`.
- **Do not invent unresolved business rules.** Put them in configuration (`registerConfig`) with the
  PRD decision id (`decision: 'DEC-07'`) and show `<DecisionTag id="DEC-07" />` where the rule is visible.
- **Server-side authorisation on every route** (`requirePerm`) and **vendor isolation**
  (`assertVendorScope`, and every vendor query filtered by `actor.vendorId`). Internal remarks never reach
  vendor responses (GOV-C08). Cross-vendor access returns 404 and is audited.
- **Audit everything** that changes state, approves, overrides, uploads, downloads restricted files or
  touches integration (`audit()`), with before/after and reason.
- Manual overrides need a reason (≥10 chars, `reasonSchema`), approver and timestamp (GOV-C02).
- Segregation of duties is enforced by the approval engine (requester/recommender cannot approve).

## Server conventions

```
server/core/        db, schema, auth, permissions, audit, notify, files, config, approvals, sap, scheduler, statuses
server/modules/<m>/ index.ts (router + init + seed)   service.ts (domain logic)   [more files if needed]
server/tests/       <m>.test.ts — use helpers.ts startApp()/login()
```

- `ModuleDef` (`modules/types.ts`): `{ path, router, init?, seed? }`, mounted at `/api/<path>`.
  `init()` runs before seeding: register approval handlers (`onDecision`), approval types
  (`registerApprovalType`), sync hooks (`onSynced`), jobs (`registerJob`), config (`registerConfig`),
  object access rules (`registerObjectAccess(ownerType, fn)` — guards files and comment threads).
- DB: `all/get/run/insert/update/scalar/tx` from `core/db.ts`. Columns ending `_json` are returned parsed
  without the suffix (`checks_json` → `checks`); write them with `J(value)`. Booleans are 0/1. Timestamps
  `now()` ISO UTC; dates `YYYY-MM-DD`. Money in rupees (REAL).
- Schema is in `core/schema.ts` (owned by the lead). If you truly need a new table/column, create it in
  your module `init()` with `CREATE TABLE IF NOT EXISTS` / guarded `ALTER TABLE … ADD COLUMN` and say so in
  your report. Prefer existing columns.
- Statuses: use exactly the strings in `core/statuses.ts`.
- HTTP: handlers `h((req) => result)`; validate with `parse(zodSchema, req.body)`; errors `badRequest`,
  `forbidden`, `notFound`, `conflict`, `new HttpError(409, 'code', msg)`; `idParam(req)`; CSV via `sendCsv`.
  Error messages say what went wrong and how to fix it, in plain words.
- Auth: `requirePerm('perm', ...)`, `actorOf(req)`, `can(actor, ...)`, `assertVendorScope(actor, vendorId, type, id)`,
  `plantAllowed`. Permissions are in `core/permissions.ts` (lead-owned; request additions in your report).
- Notifications: `notify({ event: 'NTF-xx', title, body, link, users | roles | vendorId, objectType, objectId, severity, dedupeKey })`.
  Catalogue = PRD Sec 14.2. Links point at real web routes. Vendor-facing text is vendor-safe.
- Approvals: `createApproval(actor, { type, objectType, objectId, title, summary, value, reason, context, urgency, plant, categoryCode })`
  then `onDecision(type, (approval, outcome, actor, comment) => …)` in `init()` to move your object.
  Put `recommended_by` in `context` when the requester is not the recommender. Types are listed in
  `core/approvals.ts`; the matrix is data (`approval_matrix`), fallback is the Procurement Manager.
- Config: `cfg<T>('key')`; add module settings with `registerConfig({ key, label, group, description, value, decision })` in `init()`.
- Files: upload is generic (`POST /api/files`, multipart `files`, `owner_type`, `owner_id`, `label`, `vendor_visible`) and
  returns `{ files: [{ id, filename, … }] }`. Link uploaded ids to your record with `linkAttachments(ids, ownerType, ownerId)`.
  Generated PDFs: build with `pdfkit` and `storeGenerated(buffer, name, 'application/pdf', { ownerType, ownerId })`, or stream directly.
- SAP simulator & sync (`core/sap.ts`): `sapPut(docType, key, payload)`, `sapGet`, `syncEvent(docType)` (run the inbound flow now),
  `sapWrite(flow, docType, idempotencyKey, payload, actor)` for outbound writes (returns Written / Duplicate / Queued / Failed —
  show the real status), `onSynced(docType, rows => …)` to react to new/changed SAP records, `staleInfo(flow, ts)`.
  SAP payload shapes are the ones in `seed/base.ts` (`PO`, `GRN`, `PR`, `OA`, `VENDOR`, `INVSTATUS`, `ADVPAY`, …).
- Scheduler: `registerJob({ name, label, everyMinutes, run })` — returns a short summary string.
- Seed: `seed()` creates *platform-owned* demo records for your module, using your service functions and
  `server/seed/ctx.ts` helpers (`U('amit.kulkarni')`, `V('100101')`, `M('HYD-1001')`, `PRL('10045501/10')`,
  `PO('4500021001')`, `actorFor('amit.kulkarni')`, `D(-3)` timestamps, `DAY(5)` dates). Seeds run inside one
  transaction after the base seed, in `MODULES` order. Be robust: if a record you expected from another
  module's seed is missing, skip that scenario rather than throwing.

## Web conventions

```
web/src/components/  ui.tsx (Button, ButtonLink, Badge, Status, Priority, SimBadge, DecisionTag, Freshness, PageHeader, Card, Kpi, KV,
                     Callout, Empty, ErrorState, Loader, LoadingBlock, Skeleton, Avatar, Ref, Progress, Tabs, Segmented, SectionTitle)
                     forms.tsx (Field, Input, Textarea, Select, Checkbox, ErrorSummary, fieldError)
                     overlay.tsx (Modal, Drawer, ReasonDialog, ConfirmDialog, useToast)
                     DataTable.tsx (every list: search, filters, sort, columns, saved views, bulk select, CSV export, mobile cards)
                     TrackChain.tsx (lifecycle tracker — use on record detail headers), Attachments.tsx (FileDrop, AttachmentList),
                     Thread.tsx (ThreadView, CommentThread), AuditTrail.tsx, charts.tsx (Bars, Ring, Spark)
web/src/lib/         api.ts (api.get/post/put/del/upload, downloadUrl), auth.tsx (useAuth: me, can, isVendor; useMeta),
                     hooks.ts (useAction: busy/error/toast/invalidate), format.ts (fmtDate, fmtDateTime, fmtMoney, fmtLakh, ago…), status.ts
web/src/pages/<area>/routes.tsx   export const routes: RouteObject[] (lazy pages). Vendor pages of a domain live in that domain's
                     area with paths under /vendor/… (e.g. pages/rfq has /vendor/rfqs).
```

Reference implementation: Module 1 — `server/modules/pr/*`, `web/src/pages/pr/*`, `server/tests/pr.test.ts`.
Read these first and match their structure, density and tone.

Design rules:
- Brand tokens only (`styles/tokens.css`): navy `#082D53` structure, amber `#F4B719` primary action and
  "done", plum `#7A3D97` for decisions/approvals, steel neutrals. No new colours, no gradients, no emoji.
  Space Grotesk headings (automatic on h1–h3), Inter text, JetBrains Mono for document numbers/codes (`<Ref>`, `.mono`).
- Each screen: `PageHeader` with `screen="SCR-XXX-NN"` from PRD 10.3, eyebrow breadcrumb on detail pages,
  KPI tiles only when they drill down, a `Card flush` + `DataTable` for lists, `split` layout (main + 360px
  side column) on detail pages, `TrackChain` for lifecycle where the record has stages.
- Every screen has loading (`Loader`/`LoadingBlock`), empty (`Empty` that says what to do next), error
  (`ErrorState` with retry) and success (toast naming the result, e.g. "RFQ RFQ-26-00004 published") states.
- Phone (≤760px): DataTable `mobile` cards, one task per screen, primary action reachable, camera upload
  where PRD asks for photos, nothing wider than the viewport. Test at 390px and 1440px.
- Copy: sentence case, plain verbs, buttons say exactly what happens ("Publish RFQ", "Approve", "Send for approval").
  The same action keeps its name in the toast. Errors say what failed and how to fix it.
- Never show a button the role cannot use (`can(...)`), but the server is the control.
- Use `useAction` for mutations; invalidate the query keys you change. Query keys start with the area name.

## Cross-module contracts

Quotation (`quotations.lines_json`, one entry per RFQ line the vendor quotes):
`{ rfq_line_id, no_quote: boolean, quoted_qty, basic_price, discount_pct, gst_rate, freight, packing, delivery_days,
make_brand, warranty, alternate: boolean, partial: boolean, remarks }` — amounts in rupees; `freight`/`packing` are line totals.
Header columns: `payment_terms`, `credit_days`, `delivery_terms` ('FOR' | 'Ex-Works'), `validity_date`, `remarks`.

Comparison award (`comparisons.awards_json`):
`[{ rfq_line_id, pr_line_id, vendor_id, qty, unit_price /* basic after discount */, gst_rate, freight, landed_unit, lowest: boolean, reason }]`.
When a comparison reaches **Released for PO** the SAP simulator offers "Create PO in SAP" from it; the PO payload carries
`rfq_id`, `comparison_id`, `rfq_date` and each item's `pr_no`/`pr_item`.

SAP simulator HTTP API (owned by the integration module, `/api/sap/sim/...`; other modules call or link to it):
- `POST /api/sap/sim/po` `{ source: 'comparison' | 'pr_reference' | 'manual', comparison_id?, pr_line_ids?, vendor_id?, items?, release?: boolean }` → `{ po_no }`
- `POST /api/sap/sim/po/:po_no/release`; `POST /api/sap/sim/po/:po_no/change` `{ changes: [{ item, qty?, unit_price?, delivery_date?, deleted? }], cancel?: boolean, amendment_id? }` (version + 1)
- `POST /api/sap/sim/grn` `{ po_no, items: [{ po_item, qty }], asn_id?, service?: boolean }` → `{ grn_no }`
- `POST /api/sap/sim/invoice/:inv_ref/park|post|pay|block` (`pay` body `{ payment_ref?, tds?, deductions?, retention? }`)
- `POST /api/sap/sim/advance/:adv_no/pay` `{ amount? }`, `POST /api/sap/sim/advance/:adv_no/adjust` `{ amount }`
- `POST /api/sap/sim/vendor` `{ vendor_id }` (creates SAP vendor code for an approved onboarding), `POST /api/sap/sim/vendor/:vendor_id/bank` `{ change_request_id }`
- `POST /api/sap/sim/oa` `{ contract_id }` (creates the SAP outline agreement for a platform contract), `POST /api/sap/sim/stock` `{ material_code, plant, unrestricted }`
- `POST /api/sap/sim/pr` `{ requisitioner_email, items: [...] }`; `GET/PUT /api/sap/sim/settings` (outage + failure injection)
All simulator actions are audited, require a `sapsim.*` permission, trigger the matching inbound sync immediately, and the UI
labels them "SAP simulator".
