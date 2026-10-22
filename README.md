# Equipcare Source-to-Pay platform (MVP)

Working source-to-pay web application for Knowteq Equipcare LLP, built from the PRD (Draft 1.0, 15-Oct-2026).
One responsive app covering every PRD role (requisitioner, buyer, procurement manager, vendor, stores, finance, SAP/IT, management,
administrator), merged into a single Administrator account in the default mode. SAP stays the system of record; in this MVP a **SAP simulator** stands in for it.

## Run it

Requires Node 24 (uses the built-in `node:sqlite`) and, for the screenshot/crawl helpers only, Python with Playwright.

```
npm install
npm run dev          # API on http://127.0.0.1:4000, web on http://localhost:5173 — open the web address, there is no sign-in
npm run seed         # wipe data/ and recreate the demo data
npm test             # API tests (run from PowerShell on Windows)
npm run build && npm start    # production: one server on http://localhost:4000 serving app + API
```

### Single-user mode (default)

The app opens straight into one **Administrator** account that holds every internal module at once (PR workbench, RFQs, comparisons,
approvals, contracts, POs, ASN and disputes, invoices, payments, vendors, tickets, reports, SAP integration, administration). There is
no sign-in screen, no password and no role switching. If you start it on a database from an older multi-user install, the other
accounts are merged into the Administrator automatically (their records are reassigned; the audit trail keeps the original names).

- **Vendor portal:** vendors have no accounts. Open **Administrator menu → Open the vendor portal as…** (or the rail button) and pick a vendor
  company; you then see only that vendor's RFQs, POs, ASNs, invoices, payments and messages, exactly as the vendor would. **Exit vendor portal**
  returns to the admin workspace. The choice is kept per browser, so another tab or script cannot flip your workspace.
- **Local access only:** with no sign-in, anyone who can reach the server is the Administrator. The API therefore listens on `127.0.0.1`
  only and answers only to the host names `localhost`, `127.0.0.1` and `[::1]`; other origins are refused. Do not expose it to a network
  (`HOST` and `S2P_ALLOWED_HOSTS` exist for deliberate exceptions).
- **Segregation of duties still applies.** A request the Administrator raised or recommended cannot be approved by the same account
  (FR-APR-09). Approvals raised in the demo history by other people (now merged) can be approved; new requests the Administrator raises
  itself wait for a second approver account. Use multi-user mode for workflows that need a second person.

### Multi-user mode (PRD target model)

`S2P_SINGLE_USER=0 npm run seed` and `S2P_SINGLE_USER=0 npm run dev` give the full model: a sign-in screen, per-role accounts, vendor
one-time-code sign-in, role-scoped navigation and segregation of duties. Demo accounts (password `Equipcare@2026`):

| Persona | Role |
| --- | --- |
| Priya Nair, Rahul Deshmukh, Farhan Qureshi | Requisitioner |
| Amit Kulkarni, Sneha Patil | Procurement buyer |
| Vikram Joshi | Procurement manager / approver (also buyer) |
| Meera Iyer, Kiran Shah | Finance |
| Suresh Pawar, Lakshmi Reddy | Stores |
| Neha Gupta | SAP / IT |
| Rajesh Menon | Management |
| Anjali Verma | System administrator |
| Manoj Kale (Hydrotech), Divya Raman (Shakti), Sanjay Agrawal (Western Lubricants), Pooja Malhotra (Precision), Imran Sheikh (Deccan), Nitin Sawant (Kranti) | Vendors |
| Ravi Teja (Orion Seal) | New vendor still being onboarded |

### Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `S2P_SINGLE_USER` | on | `0` switches to multi-user mode |
| `S2P_DEMO_EXTRA` | on | `0` seeds only the small base data set (the test suites use this) |
| `PORT`, `HOST` | 4000, `127.0.0.1` | where the API listens |
| `S2P_ALLOWED_HOSTS` | — | extra host names the single-user server may answer to |
| `S2P_DATA_DIR` | `data/` | where the database and files live |
| `ANTHROPIC_API_KEY` | — | optional. With the business rule **AI-worded summaries** switched on, a model rewords one summary paragraph from facts the rules computed. Unset: nothing leaves the server |
| `S2P_AI_MODEL` | `claude-sonnet-5-5` | model used for that wording |

## How the Administrator workspace is organised

SAP stays the system of record; this app is where collaboration, workflow and follow-up happen. The sidebar has three
workspaces instead of fifteen modules, and each keeps the module screens one click away in a tab strip:

- **Sourcing**: PR workbench, RFQs, comparisons, approvals, contracts, vendors
- **Delivery**: purchase orders, ASN & dispatch, expected receipts, disputes, vendor tickets
- **Finance**: invoices, exception queue, payments & advances

Home is *Ask* (plain-language questions), *Act now* (work that needs you, with a next step) and *At risk* (late deliveries,
held invoices, blocked payments, low RFQ response, ending contracts, each with its reasons).

## What is live and what is simulated

| Area | Status in this MVP |
| --- | --- |
| Workflows, approvals, audit trail, roles, validation, files, reports, notifications (in-app) | **Real**, persisted in SQLite (`data/s2p.db`) |
| SAP (vendors, materials, PRs, stock, outline agreements, POs, GRN/SES, invoice and payment status) | **Simulated.** `sap_documents` is the SAP stand-in; inbound flows INT-M01…M12 sync it into the platform with idempotent writes, retry, error queue and reconciliation. The simulator console (`/sap-simulator`) plays the SAP user. No live SAP connection exists. Every screen that shows simulated SAP says so. |
| Invoice OCR | **Simulated.** No OCR engine is connected: the uploader supplies the invoice values and a deterministic engine "reads" them with per-field confidence. Validation, 3-way match, tolerances and exceptions are real logic. |
| E-mail / SMS / WhatsApp | **Simulated.** Messages are recorded in an outbox marked "not delivered". |
| Malware scan | Only the EICAR test signature is checked; no antivirus engine is connected. |
| Single sign-on | Not configured (DEC-12). Internal users sign in with a password. |
| Assistance layer (delivery risk, invoice explanation, vendor-reply reading, ask box) | **Real, rule-based.** No AI model is needed or connected by default. See [docs/AI_ASSIST.md](docs/AI_ASSIST.md). An optional model only rewords the invoice summary; it is off by default and untested against the live API in this build. |

Unresolved business rules are **configuration**, not code, and carry their PRD decision id (DEC-xx) in Administration → Business rules:
approval matrix (placeholder), 3-way-match tolerances (zero until jointly approved), landed-cost components, late/risk discount, SLAs,
reminder schedules, deemed acceptance, dispute responsibility matrix, notification channels and more.

## Layout

```
server/core/       database, schema, auth & permissions, audit (hash-chained), notifications, files, config, approvals engine, SAP adapter + simulator core
server/modules/    one folder per PRD module (pr, rfq, cmp, approvals, contracts, po, asn, vendors, invoices, payments, sap, reports, admin, home)
server/seed/       demo data (masters, users, SAP documents, per-module scenarios)
server/tests/      API tests per module + e2e.test.ts (full RFQ-to-payment chain)
web/src/           shell, design system (components/), pages per module
docs/              ENGINEERING.md (conventions), PRD.md (requirements extract), COVERAGE.md (what is built), AGENT_BRIEF.md
scripts/           crawl.py (visit every nav item per role), shot.py (screenshots), inspect.ts / q.ts (data helpers)
```

Branding follows equipcare.in: logo files from the site; **purple** `#7A3D97` (the site's plum) as the primary colour with **yellow** `#F4B719` (the logo mark) as the secondary; Space Grotesk and Inter.
