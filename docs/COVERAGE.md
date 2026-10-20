# Coverage against the PRD

Status as built. Run modes: **single-user** (default: no sign-in, one Administrator holding every internal module, vendor portal reached by
acting as a vendor company) and **multi-user** (the PRD's per-role accounts; `S2P_SINGLE_USER=0`). API tests live in `server/tests`
(233, mostly in multi-user mode, plus `single-user.test.ts`, `e2e.test.ts` and the extended-data suites). Every list screen was opened as the
Administrator and as six vendor companies with `scripts/crawl.py`, and record detail pages with `scripts/crawl_details.py`, at desktop and 390 px
phone width, with no console errors, failed API calls, error screens or horizontal overflow.

| PRD module | Built | Where |
| --- | --- | --- |
| M1 PR workbench and route decision | Yes — SAP sync, buyer matrix, four checks, route proposal/override with approval, repeat-purchase flag, baskets, ageing, priority SLA, clarifications, requisitioner view | `modules/pr`, `pages/pr` |
| M2 RFQ automation | Yes — builder, deterministic vendor suggestions with reasons, limited-source exception, publish/remind/extend/close/cancel/re-float/reopen, sealed prices, RFQ PDF | `modules/rfq`, `pages/rfq` |
| M3 Vendor quotation | Yes — line-wise entry, drafts, versions, alternate/partial, decline, lock, approved reopen | `modules/rfq`, `pages/rfq` |
| M4 Comparative statement | Yes — landed-cost formula, LPP/contract/budget variance, late/risk discount approval, split award, deviation approval, locked PDF, release for PO | `modules/cmp`, `pages/cmp` |
| M5 Approvals and exceptions | Yes — configurable matrix (versioned), parallel levels, SoD, clarification, delegation, escalation, ageing, exception register | `core/approvals.ts`, `modules/approvals`, `pages/approvals` |
| M6 Contracts, ARC, OA, VMI, FDS | Yes — repository, Pending SAP flow, price-list versions, VMI min-max alerts, opportunities, renewals, off-contract alerts | `modules/contracts`, `pages/contracts` |
| M7 PO, acknowledgement, open PO | Yes — publish, line-wise acknowledgement, commitment history, reminders, escalation, deemed acceptance (config), amendment/cancellation through SAP | `modules/po`, `pages/po` |
| M8 ASN, receipts, disputes | Yes — ASN with versions and pickup, expected receipts, dispute owner by delivery term, evidence, outcome, closure approval (config), ageing | `modules/asn`, `pages/asn` |
| M9 Vendor portal and onboarding | Yes — registration by invitation, KYC review, capability approval, bank-change maker-checker, tickets, vendor-only data | `modules/vendors`, `pages/vendors`, `pages/vendor-portal` |
| M10 Invoice OCR and 3-way match | Yes (OCR simulated) — duplicate/GSTIN/PAN/bank checks, seven match rules, FDS price check, exception queue, corrections audit, finance-approval control | `modules/invoices`, `pages/invoices` |
| M11 Payments and advances | Yes — status language, advance request/approval/SAP payment/adjustment, ageing, payment advice PDF, vendor whitelist | `modules/payments`, `pages/payments` |
| M12 SAP integration and monitoring | Yes (SAP simulated) — monitor, error queue with replay/discard, reconciliation, runbook, failure injection, simulator console | `core/sap.ts`, `modules/sap`, `pages/integration` |
| Reports and KPIs | Yes — RPT-01…12 with drill-down and CSV export, KPI-01…15 (no baselines or targets invented) | `modules/reports`, `pages/reports` |
| Notifications | NTF-01…33 in-app; e-mail/SMS to the simulated outbox; preferences, digest, dedupe | `core/notify.ts` |
| Roles and dashboards | All nine roles with their own home and navigation | `modules/home`, `nav.ts` |
| Administration | Users and roles, business rules (versioned, tolerance changes need two approvals), master mappings, jobs, outbox, audit viewer | `modules/admin`, `pages/admin` |

## Demo data

Default seed (`npm run seed`): 36 vendors, 66 materials, ~250 requisitions, 115 POs with ~170 goods receipts over 11 months, 29 RFQs with 70 quotations,
14 comparisons, 79 approvals (all statuses and ageing buckets), 28 contracts, 70 invoices covering every status and exception reason, 18 advances,
19 ASNs, 19 disputes, 17 tickets and SAP monitor history. `S2P_DEMO_EXTRA=0` seeds only the small base set (the multi-user test suites use it).

## Known gaps and deviations

- **Single-user mode and segregation of duties:** FR-APR-09 (requester cannot approve own request) is still enforced, so with one account, new requests the
  Administrator raises wait for a second approver. Relaxing this was not implemented (it needs an explicit decision, see README).

- **Not built:** Excel-template upload of quotation lines (FR-QTN-09, proposed); AI enhancements AI-01, 03–07; a live SAP, OCR, e-mail/SMS or SSO integration.
- **Database:** SQLite instead of the PRD's recommended PostgreSQL, to run with no infrastructure. The data layer is isolated in `server/core/db.ts`.
- **Approvals:** the approver shown is the role holder (e.g. "Finance"), not a named person; delegation is supported.
- **Invoice preview:** highlighted field boxes need real OCR coordinates, which the simulation does not have. PDF preview uses the browser's viewer.
- **Any buyer can edit another buyer's Draft RFQ** (the PRD only says buyers create and manage RFQs).
- **Non-functional targets** (performance, availability, RPO/RTO, WCAG audit) are not measured; they are open decisions (DEC-23). Keyboard focus, labels, reduced motion and phone layouts are implemented and checked.
- **Business parameters** (approval matrix, tolerances, SLAs, landed-cost components, thresholds) are placeholders marked with their decision ids until Equipcare approves values.
