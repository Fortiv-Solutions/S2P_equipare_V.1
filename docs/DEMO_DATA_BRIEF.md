# Extended demo data — brief for the four seed engineers

Goal: the demo should look like a working procurement operation, not a few samples. The SAP side is already extended
(`server/seed/base_extra.ts`: 28 vendors, 66 materials, ~250 PR lines, ~110 POs with ~165 GRNs, 19 opportunities, 10 contracts).
Your job is the **platform-owned records** on top of it, for your modules only. Read `docs/ENGINEERING.md` (conventions, seed
helpers) and `server/seed/base_extra.ts` (what exists and how it is numbered) first, then your modules' existing `seed.ts` files
(they show how to call each service as a persona).

## Ground rules
- Gate everything on `DEMO_EXTRA` from `server/core/mode.ts`: add `server/modules/<m>/seed_extra.ts` exporting `seedExtra()` and call it
  at the end of that module's existing `seed()` only `if (DEMO_EXTRA)`. Do not change what the existing seeds create.
- **Deterministic.** Use a small seeded RNG (copy `rng()` from `base_extra.ts`); never `Math.random()`. Same data every seed.
- **Use the services as the right persona** (`actorFor('amit.kulkarni')`, `U()`, `V()`, `PRL()`, `PO()` from `server/seed/ctx.ts`) so validations,
  numbering, notifications and audit run exactly as in real use. Where the service uses `now()` and you need history, **backdate the domain
  row with SQL afterwards** (created_at, submitted_at, closed_at …). **Never edit `audit_events`** — it is hash-chained.
- Seeds run in one transaction after the base seed and in `MODULES` order (pr, rfq, cmp, approvals, contracts, po, asn, vendors, invoices,
  payments, sap, reports, admin, home). Anything another engineer's seed creates may or may not exist yet: look it up, and skip the scenario
  with a `console.warn('<module> seed_extra: …')` if it is missing. **A fresh seed must print no warnings from your module.**
- Personas exist during seeding and are merged into one Administrator afterwards, so segregation of duties holds while you seed
  (requester ≠ approver): raise as one persona, approve as another.
- Spread dates over the last ~11 months so trends and ageing reports look real. Keep the whole seed under ~5 s.
- Do not touch core files, other modules, `schema.ts`, `permissions.ts`, `nav.ts`, shared components, or tests of other modules.
- Test your work in isolation, never against the shared database: `$env:S2P_DATA_DIR='data/agent-<name>'; npm run seed` (PowerShell), inspect with
  `node scripts/_counts.cjs data/agent-<name>/s2p.db`-style queries, and delete your data dir at the end. Existing suites must still pass
  (`npx vitest run` from PowerShell; they run with the extras OFF). Add `server/tests/<your-area>-extra.test.ts` that starts the app with
  `startApp({ demoExtra: true })` and asserts your volumes and a few invariants (every row links to something real, statuses are canonical
  from `core/statuses.ts`, `/api/audit/verify` is ok).

## Volumes (targets — "at least")
**A — Sourcing (modules pr, rfq, cmp, approvals).**
Run checks and decide routes for ~45 of the open PR lines `10046001+` (and the older open ones) as the right buyer: most confirmed (RFQ / ARC-OA /
FDS / VMI / Fixed supplier / Urgent-BD / Class 1 / Service / Capex), a few overrides that raise off-contract approvals, some on hold, some with clarification threads
with the requisitioner, two closed. RFQs: grow from 4 to ≥ 18 in every state (Draft ×3, Published ×4 with mixed vendor participation and closing dates incl. one closing
today, Closed ×2, Under comparison ×2, Awarded ×4, Cancelled ×1, Re-floated ×1, a limited-source one pending approval, one ARC annual-rate RFQ from an
opportunity). ≥ 3 invited vendors each with realistic quotations around the material's LPP (different delivery days, GST, freight, Ex-Works/FOR, a few
alternate/partial quotes, declines, non-responders). Comparisons ≥ 8 across Draft, Recommendation recorded, Submitted (pending at level 1 and level 2), Approved, Returned,
Rejected, Released for PO (link `rfq_id`/`comparison_id` on a few of the historic extra POs where it fits). Approvals ≥ 28 in total across types and statuses incl. exceptions
(single source, urgent, PO after receipt, off-contract, price amendment), with created dates spread so the ageing buckets all have rows.

**B — Fulfilment (modules po, asn).**
Acknowledge the extra POs (`4500030001+` historic, `4500031001+` open) realistically: historic all accepted with first and latest commitment; open ones per their
design — fresh (some unviewed, some viewed-not-acknowledged with reminders), accepted with commitments, partial acceptance, a rejected line, overdue with delay reasons
(varied codes), reminder counts, level-2 and level-3 escalations, follow-up notes with next-action dates. Amendments ≥ 5 in different states (requested, approved awaiting SAP,
republished, re-acknowledged, declined; one cancellation). ASNs ≥ 14 (Draft, Submitted, In transit, Delivered matched to GRN, an Equipcare pickup overdue, a cancelled one) with
documents. Disputes ≥ 12 across all types, owners (vendor / procurement / stores / finance / logistics), delivery terms and statuses (Raised … Closed), ageing spread from 1 to
40 days, evidence, vendor responses, outcomes with amounts, one needing closure approval.

**C — Finance (modules invoices, payments).**
≥ 36 invoices in total on the extra POs (historic closed ones mostly paid), covering **every** status and exception reason: Uploaded, OCR pending, Validation pending, Exception
(price variance, excess billing, pending GRN, tax mismatch, unapproved freight, duplicate, GSTIN invalid, bank mismatch, dispute hold, low OCR confidence), Matched (awaiting finance
approval), Parked, Posted, Payment due, Payment released (with TDS, deductions, retention, payment advice), Payment blocked, Rejected to vendor. Invoice dates spread over 11 months
so payment ageing and KPI-10/11 are meaningful; some uploaded by finance on a vendor's behalf; FDS price checks. Advances ≥ 8: Requested, Pending approval (level 1 and 2), Approved,
Paid, Partially adjusted, Fully adjusted, Rejected, Cancelled, with ageing across all configured buckets.

**D — Masters and support (modules contracts, vendors, admin; plus SAP monitor history if you have time).**
Contracts: platform-created ≥ 8 more in Draft, Pending approval, Pending SAP, Expiring, Expired, Renewed, Terminated (FDS with price-list versions, VMI with min-max, ARC with item
utilisation > 80%), off-contract alerts ≥ 5 (some justified, some dismissed with reason), opportunities decided (accepted → draft ARC, rejected with reason, under review).
Vendors: ≥ 5 more in onboarding states (Invited, Registration in progress, Submitted, Under review, Clarification requested, Approved → Pending SAP code), capability
proposals pending/rejected, bank-change and profile change requests in several states, KYC documents expiring/expired across ≥ 8 vendors. Tickets ≥ 12 across all categories and
statuses (Open, In progress, Awaiting vendor, Resolved, Closed) with message threads incl. internal notes and SLA breaches. Integration history: ≥ 40 job runs over the last days,
a few resolved and discarded integration errors with reasons.

## Final report (short)
Files created; counts per table you added; scenarios skipped and why; confirmation that fresh seed prints no warnings from your module, that the existing suites still
pass, and your new test passes; your scratch data dir removed.
