# Knowteq Equipcare LLP — Source-to-Pay PRD (Draft 1.0, 15-Oct-2026) — implementation extract

Extract of the PRD sections needed to build the product (Sections 6, 7, 8, 9, 10.3, 13, 14, 18). Labels:
[SRC] confirmed by BRD, [DER] derived by Fortiv, [REC] recommendation, [OPEN] open decision, [ASM] assumption,
[Q] question for Equipcare, [ENH] enhancement. Unresolved items must be configurable or flagged, never invented.

## 6. Roles and permissions

Roles: R1 Requisitioner (REQ), R2 Procurement Buyer (BUY), R3 Procurement Manager / Approver (APR), R4 Vendor (VEN),
R5 Stores / Warehouse (STO), R6 Finance / Accounts (FIN), R7 SAP / IT Team (SAP), R8 Management (MGT), R9 System Administrator (ADM).
SAP/IT and System Administrator never approve commercial or financial decisions.

Permission matrix (V view, C create/edit, A approve). "Own" limits to the user's records; vendors see only their own vendor's data (GOV-C09).

| Capability | REQ | BUY | APR | VEN | STO | FIN | SAP | MGT | ADM |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PR status and buyer | V own | V, C | V | — | V | V | — | V | — |
| Route decision, buyer assignment | — | C | A (overrides) | — | — | — | — | V | — |
| RFQ create, invite, extend, cancel | — | C | A (where rule requires) | V own invitations | — | — | — | V | — |
| Quotation entry | — | V after close | V after close | C own | — | — | — | — | — |
| Comparative statement, award recommendation | — | C | A | — | — | V | — | V | — |
| Approval decisions | — | — | A | — | — | A (finance steps) | — | A (if in matrix) | — |
| Contract / ARC / OA / FDS / VMI repository | — | C | A | V own | — | V | — | V | — |
| PO view, follow-up, reminders | V own PR | C | V | V own, acknowledge | V | V | — | V | — |
| ASN, dispatch | V own PR | V | V | C own | V | V | — | V | — |
| Receipt discrepancy, dispute | V own PR | C | A (closure rules [Q]) | respond own | C | V, C (hold) | — | V | — |
| Invoice upload | — | V | V | C own | — | C (on behalf [Q]) | — | V | — |
| OCR correction, 3WM exception resolution | — | V, comment | V | V own status | — | C, A | — | V | — |
| Advance request | — | C | A | V own | — | A, C (payment data) | — | V | — |
| Payment status | — | V | V | V own (controlled fields) | — | V | — | V | — |
| Dashboards and reports | own | team | department | own scorecard [Q] | stores | finance | integration | all | audit |
| Integration monitor, retries | — | — | — | — | — | — | C | — | V |
| Users, roles, configuration | — | — | — | own vendor users [Q] | — | — | — | — | C |
| Audit log | own records | own records | department | — | — | finance records | technical logs | V | V |

Restrictions: Requisitioner cannot see vendor prices or other departments' PRs [ASM]. Buyer cannot approve own recommendation, cannot edit a vendor quote, cannot change a quote after close without reopen. Approver cannot approve a request they raised. Vendor: own data only; no internal remarks, other vendors' prices or rank. Stores cannot alter PO or invoice; GRN only in SAP. Finance corrections only with reason, audited. SAP/IT: no business approvals; no edit of business data except controlled replay. Management read-only by default. Administrator cannot approve transactions; admin actions audited. [REC] split R9 into Platform Administrator and Business Configuration Owner ([Q]).

## 7.0 Rules for every module

FR-PLT-01 immutable audit event for every create/update/status change/approval/override/upload/restricted download/integration action (who, role, when, what, before/after, reason, IP/channel). FR-PLT-02 manual override needs reason, approver, timestamp. FR-PLT-03 server-side authorisation. FR-PLT-04 SAP-sourced records show last successful sync; stale badge beyond threshold. FR-PLT-05 lists: filter, sort, saved views, export Excel/CSV per permission. FR-PLT-06 every transactional object has owner, status, created date, due date where applicable, ageing. FR-PLT-07 attachments PDF/image/Office, limits configurable, virus-scanned. FR-PLT-08 business rules are configuration with effective dates and versions.

## 7.1 Module 1 — PR Workbench (BUILT — reference implementation)

## 7.2 Module 2 — RFQ automation and vendor enquiry (SOP KE-PRC-03, R2)

Entry: PR lines routed to RFQ (or urgent/BD/Class 1) with checks complete. Inputs: RFQ basket lines, material master, vendor capability mapping, spend category master (minimum vendor count), plant/ship-to, GST and valuation from SAP.

| FR | Requirement | Source |
| --- | --- | --- |
| FR-RFQ-01 | Create an RFQ from one or more PRs and lines, keeping each RFQ line linked to its PR line | RFQ-01 Must |
| FR-RFQ-02 | Suggest vendors per line with deterministic criteria: spend category, sub-category, OEM/brand, approved status, plant/location, performance, past participation, contract availability; show why each vendor was suggested | RFQ-02 Must |
| FR-RFQ-03 | Buyer adds new/alternate vendors with justification; route to approval where the rule requires | RFQ-03 Must |
| FR-RFQ-04 | Publish on the portal and send e-mail to each invited vendor contact; store invitation list, send time, delivery outcome | RFQ-04 Must |
| FR-RFQ-05 | RFQ carries description, quantity, required date, plant, shipping location, delivery terms, warranty, packing, documents required, standard terms | RFQ-05 Must |
| FR-RFQ-06 | Auto-fill GST rate, discount field, valuation type, plant, ship-to, transport requirement from master data; buyer can edit with audit | RFQ-06 Must |
| FR-RFQ-07 | Due date per line and automatic vendor reminders before and after closing on a configurable schedule | RFQ-07 Must |
| FR-RFQ-08 | Track each invited vendor as Invited, Viewed, Responded, Declined, Not responded | RFQ-08 Must |
| FR-RFQ-09 | Extension, cancellation, re-float, each with recorded reason; vendors notified | RFQ-09 Should |
| FR-RFQ-10 | Attach drawings, images, specifications, catalogues, site notes at RFQ or line level | RFQ-10 Must |
| FR-RFQ-11 | Fewer invited vendors than the category minimum → justification, route as single/limited-source exception | DER Must |
| FR-RFQ-12 | Sealed quotations: buyers see who responded but not prices until close | REC [Q] |

Rules: cannot publish without ≥1 line, ≥1 invited vendor, future closing date and all RFQ-05 fields. Suggestions exclude vendors blocked in SAP or with expired mandatory KYC documents. Vendor without SAP code invitable only if Equipcare permits [Q] (config, default off). Reminder defaults are proposals [Q].
States: Draft → Pending approval (if exception) → Published → (Extended, repeatable) → Closed → Under comparison → Awarded | Cancelled | Re-floated (linked new RFQ).
Exceptions: e-mail bounce → invitation "delivery failed", buyer alerted. PR cancelled in SAP during RFQ → line flagged; buyer removes or keeps with reason. No responses at closing → buyer must extend, re-float or record exception.
Notifications NTF-04 invitation, NTF-05 closing reminder, NTF-06 extended/cancelled, NTF-07 RFQ closed to buyer. Audit: suggested list and reasons, final list, add/remove justification, publications, extensions, cancellations, views. SAP: INT-M01, M02, INT-M05 RFQ reference (DEC-04). Outputs: RFQ PDF per vendor; RPT-02.
ACs: AC-RFQ-01 lines from 3 PRs keep source PR/line. AC-RFQ-02 approved unblocked vendors mapped to category+plant suggested with reason. AC-RFQ-03 non-suggested vendor without justification blocks publication. AC-RFQ-04 audit lists each invited vendor, send time, e-mail delivery status. AC-RFQ-05 missing required date/ship-to blocks publish naming field. AC-RFQ-06 GST and ship-to pre-filled. AC-RFQ-07 reminders only to non-responders. AC-RFQ-08 vendor open → Viewed with timestamp. AC-RFQ-09 extend without reason rejected. AC-RFQ-10 15 MB drawing downloadable by invited vendors, download logged.

## 7.3 Module 3 — Vendor quotation entry (R2)

| FR | Requirement | Source |
| --- | --- | --- |
| FR-QTN-01 | Vendor enters a quotation against each RFQ line in the portal | QTN-01 Must |
| FR-QTN-02 | Per line: basic price, discount, GST rate, freight, packing/forwarding, delivery days, payment terms, warranty, make/brand, validity, remarks; valuation type where applicable | QTN-02 Must |
| FR-QTN-03 | Upload signed quotation, datasheet, price list, warranty terms, other docs | QTN-03 Must |
| FR-QTN-04 | Alternate make/brand or partial quantity, clearly marked | QTN-04 Should |
| FR-QTN-05 | After closing quotations are locked; changes only if buyer reopens with reason and the reopen is approved | QTN-05 + GOV-C03 Must |
| FR-QTN-06 | Every revision kept as numbered version with timestamp and changed values | QTN-06 Should |
| FR-QTN-07 | Vendor can decline with reason | VP-A03 Must |
| FR-QTN-08 | Save draft; submission returns acknowledgement with timestamp and reference | DER Must |
| FR-QTN-09 | Excel template upload for many lines | REC Proposed |

Rules: mandatory per line basic price, GST rate, delivery days, validity. GST from allowed list; prices ≥ 0; discount 0–100%; validity ≥ RFQ closing date. INR [ASM]. Reopen = reason + approval (stricter of QTN-05/GOV-C03).
States: Not started → Draft → Submitted → Revised (n) → Locked at close → Reopened (approved) → Final. Alt: Declined.
Exceptions: submit after close rejected, nothing saved; virus-scan failure rejects file with reason.
NTF-08 quotation received (count only while sealed), NTF-09 RFQ reopened. ACs: AC-QTN-01 entry row with all QTN-02 fields; AC-QTN-02 missing GST blocks naming line+field; AC-QTN-03 docs listed after close; AC-QTN-04 "Alternate, partial 60/100" in comparison; AC-QTN-05 edit after close rejected; after approved reopen accepted and versioned; AC-QTN-06 history shows changed fields and timestamps.

## 7.4 Module 4 — Comparative statement and award (R2)

| FR | Requirement | Source |
| --- | --- | --- |
| FR-CMP-01 | Generate comparative statement automatically, line-wise and RFQ-wise | CMP-01 Must |
| FR-CMP-02 | Landed cost from price, discount, GST impact, freight, packing, payment terms, delivery condition (formula below) | CMP-02 Must |
| FR-CMP-03 | Late discount and risk discount as separate fields; any use needs approval | CMP-03 Should |
| FR-CMP-04 | Show LPP, contract price, budget price, previous vendor performance with variance % | CMP-04 Should |
| FR-CMP-05 | Award recommendation per line + justification; not lowest landed cost → reason and deviation approval | CMP-05 Must |
| FR-CMP-06 | Show invited, responded, declined, non-participating vendors and enquiry coverage | CMP-06 Should |
| FR-CMP-07 | Split award across vendors by line (and by quantity where policy allows [Q]) | DER |
| FR-CMP-08 | Export approved comparison as locked PDF for the SAP PO record | DER Must |

Formula (vendor v, line l, qty q, basic price P, discount d, freight F, packing K, GST G):
Taxable = P(1−d)q + F + K; Landed = Taxable(1 + γG) − PTA − LD − RD; Unit landed = Landed / q.
γ = 1 if GST is a cost (ITC not available), 0 if recoverable [Q DEC-21 — per category or plant]. PTA payment-term adjustment = Taxable × cost-of-money × (vendor credit days − reference days)/365 [Q DEC-21]. LD/RD approved late/risk discount amounts [Q DEC-18]. Ex-Works quotes add estimated inbound freight to F; FOR uses F as quoted [Q DEC-21]. Freight and packing taxable [ASM].
Rules: comparison only on locked quotes; reopen regenerates as new version. Alternate/partial ranked separately unless buyer marks acceptable. Lowest landed cost highlighted per line; ties show both.
States: Draft → Recommendation recorded → Submitted for approval → Approved | Returned | Rejected → Released for PO (SAP).
ACs: AC-CMP-01 3 quotes × 4 lines → 4 rows + RFQ total per vendor; AC-CMP-02 landed cost equals formula to 2 decimals; AC-CMP-03 late discount needs approval and shows separate columns; AC-CMP-04 LPP and variance %; AC-CMP-05 second-lowest without reason blocked, with reason creates deviation approval; AC-CMP-06 coverage 4/6 responded lists non-participant.

## 7.5 Module 5 — Approval workflow and governance (R2)

| FR | Requirement | Source |
| --- | --- | --- |
| FR-APR-01 | Configure routing by value, category, route, urgency, deviation type, authority matrix; sequential and parallel levels; effective dates | APP-01 Must |
| FR-APR-02 | Approver sees comparison, selected vendor, justification, LPP/contract reference, delivery impact and deviation remarks on one screen | APP-02 Must |
| FR-APR-03 | Approve, reject, seek clarification, return to buyer; reject and return need a comment | APP-03 Must |
| FR-APR-04 | Single source, urgent, PO after receipt, off-contract, price amendment need reason and approval | APP-04 Must |
| FR-APR-05 | Pending approval and approval ageing dashboard by approver, level, type | APP-05 Must |
| FR-APR-06 | Reminder and escalation beyond threshold; delegation during absence with audit | DER Must |
| FR-APR-07 | PO amendment and cancellation request types with SAP update confirmation and vendor confirmation | KE-PRC-13 Must |
| FR-APR-08 | Exception register: every exception with type, reason, approver, outcome; periodic review view | KE-PRC-14 Must |
| FR-APR-09 | A user cannot approve a request they created or recommended | DER Must |
| FR-APR-10 | Each request stores the matrix version applied | DER Must |

No amounts/levels/approvers defined in PRD; Equipcare provides matrix (DEC-13). Mobile approval allowed [REC]. Return restarts from level 1 [ASM].
States: Submitted → Pending level n → (Clarification requested ↔ answered) → Approved | Rejected | Returned | Withdrawn.
ACs: AC-APR-01 two value bands route to configured approvers; AC-APR-02 all APP-02 elements visible on one screen; AC-APR-03 reject without comment blocked; AC-APR-04 off-contract creates exception approval logged in register; AC-APR-05 ageing buckets for 1/3/6 days; AC-APR-06 own request: approve unavailable and API refuses.
Screens: SCR-APR-01 Approval Inbox (pending with type, value, age; bulk approve where allowed [Q]) — primary phone screen; SCR-APR-02 Approval Decision (all APP-02 context; summary first on phone); SCR-APR-03 Exception Register (type, reason, approver; review, export).

## 7.6 Module 6 — Contract / ARC / OA / VMI / FDS (R3)

| FR | Requirement | Source |
| --- | --- | --- |
| FR-CON-01 | Repository of contract/ARC/OA/FDS: vendor, category, material/service scope, price, discount, validity, terms, documents, linked SAP OA number | CON-01 Must |
| FR-CON-02 | Identify items/categories suitable for ARC/OA from annual frequency, value, vendor concentration — opportunity list | CON-02 Must |
| FR-CON-03 | Flag off-contract purchase where a valid ARC/OA/FDS exists: at route decision, at RFQ creation, and on synced SAP POs without contract reference | CON-03 Must |
| FR-CON-04 | Track validity, renewal due, price revision date, utilisation; remind at configurable lead times | CON-04 Must |
| FR-CON-05 | Fixed discount structures: price list version, discount %, invoice validation flag used by Module 10 | CON-05 Should |
| FR-CON-06 | VMI terms: min-max, replenishment frequency, billing cycle, reconciliation | CON-06 Should |
| FR-CON-07 | VMI min-max status from SAP stock; replenishment alert to vendor and buyer below minimum | KE-PRC-10 Should |
| FR-CON-08 | ARC creation workflow: opportunity → sourcing (annual-rate RFQ via Module 2) → approval → SAP OA creation → repository link | KE-PRC-11 Must |
| FR-CON-09 | Platform never replaces the SAP OA; record without SAP OA number is "Pending SAP" and cannot route PRs | CON-01 Must |

Rules: thresholds config (DEC-09). Valid for routing = within validity, active in SAP, remaining qty/value > 0. Price-list history kept; invoices validated against version effective on PO date [ASM][Q].
States: Draft → Pending approval → Pending SAP → Active → Expiring (within lead time) → Expired | Renewed | Terminated. Opportunity: Identified → Under review → Accepted (sourcing started) | Rejected (reason).
NTF-13 expiry/renewal, NTF-14 off-contract, NTF-15 VMI below minimum. Outputs RPT-06, RPT-07, renewal dashboard.
ACs: AC-CON-01 synced OA shows vendor, scope, price, validity, docs, SAP OA no; AC-CON-02 opportunity job lists item with frequency, value, vendor count; AC-CON-03 synced SAP PO without OA reference for covered material raises off-contract alert; AC-CON-04 contract within lead time notified and shown Expiring; AC-CON-05 FDS 12% on price list v3 → invoice expected price v3 less 12%; AC-CON-06 VMI min 10, stock 8 → alert to vendor and buyer.
Screens: SCR-CON-01 repository, SCR-CON-02 detail (terms, prices/price lists, documents, utilisation, history; edit with approval, renew), SCR-CON-03 ARC/OA opportunities (accept, reject with reason), SCR-CON-04 renewal dashboard.

## 7.7 Module 7 — PO, acknowledgement, open PO (R1)

| FR | Requirement | Source |
| --- | --- | --- |
| FR-POM-01 | Publish each released SAP PO to the portal with a PO document; only released POs | PO-01 Must |
| FR-POM-02 | Vendor acknowledges line-wise: accepted, rejected or partially accepted qty, delivery commitment date, deviation remarks | PO-02 Must |
| FR-POM-03 | Deemed acceptance configurable (on/off, timeline); PO shows "Deemed accepted" and still reports non-response | PO-03 Should, DEC-16 |
| FR-POM-04 | Open PO list filterable by buyer, vendor, plant, material group, required date, PO date, urgency (BD, urgent, general stock, Class 1) | PO-04 Must |
| FR-POM-05 | Default sort PO date descending; RFQ date filter | PO-05 Must |
| FR-POM-06 | Follow-up history, latest commitment, delay reason (configurable code list), next action date per PO line | PO-06 Must |
| FR-POM-07 | Automatic reminders: pending acknowledgement, pending dispatch, delayed delivery, pending documents | PO-07 Must |
| FR-POM-08 | Escalate per escalation matrix when reminders get no response | KE-PRC-06 Must |
| FR-POM-09 | Amendment/cancellation: request → approval → change in SAP → amended PO republished with version → vendor re-acknowledges | KE-PRC-13 Must |
| FR-POM-10 | Write acknowledgement to SAP when DEC-25 decides; until then the platform is the record | INT-M08 [OPEN] |
| FR-POM-11 | Requisitioner sees PO, commitment, dispatch status for own PR lines | Must |

Rules: partial acceptance needs accepted qty < ordered and reason; rejected lines alert buyer immediately. Commitment change after ack needs delay reason; history kept (first and latest commitment both kept; which counts for KPI-07 [Q]). Urgency from PR route or SAP PO field [Q].
States: Published → Viewed → Acknowledged (Accepted | Partially accepted | Rejected) | Deemed accepted → In dispatch (ASN) → Partially received → Received (GRN) → Closed. Amendment: Requested → Approved → Changed in SAP → Republished → Re-acknowledged.
NTF-16 PO published, NTF-17 ack reminder, NTF-18 dispatch/delivery reminder, NTF-19 delay escalation, NTF-20 PO amended. RPT-04 open PO, RPT-05 vendor follow-up.
ACs: AC-POM-01 released PO visible to vendor, unreleased not; AC-POM-02 accept/partial 40/50/reject with reason, buyer alerted for reject; AC-POM-03 deemed acceptance after T and listed in non-response report; AC-POM-04 Class 1 filter; AC-POM-05 newest PO first; AC-POM-06 history old/new date, reason, next action; AC-POM-07 one reminder logged.
Screens: SCR-POM-01 Open PO dashboard (ack, commitment, delay reason, urgency; remind, log follow-up, escalate), SCR-POM-02 PO detail & follow-up (lines, acks, commitment history, ASNs, GRNs, invoices), SCR-POM-03 amendment request (old vs new, reason). Vendor: SCR-VPT-05 PO list & acknowledgement (line-by-line on phone).

## 7.8 Module 8 — ASN, dispatch, logistics, disputes (R1)

| FR | Requirement | Source |
| --- | --- | --- |
| FR-ASN-01 | Vendor ASN: dispatch date, expected delivery, transporter, LR/AWB, vehicle no., e-way bill, invoice ref, packing details | ASN-01 Must |
| FR-ASN-02 | Delivery terms (Ex-Works, FOR), freight paid/payable, transit-risk responsibility on each ASN, defaulted from PO | ASN-02 Must |
| FR-ASN-03 | Pickup responsibility, pickup date and status where Equipcare arranges pickup | ASN-03 Should |
| FR-ASN-04 | ASN qty ≤ acknowledged open qty (tolerance [Q]); multiple ASNs per PO | DER Must |
| FR-ASN-05 | Stores expected-receipts list from ASNs by plant and date | KE-PRC-08 Must |
| FR-DSP-01 | Stores record discrepancy: shortage, excess, damage, transit loss, accidental loss, wrong material, quality rejection, document mismatch | DSP-01 Must |
| FR-DSP-02 | Workflow and default owner differ for Ex-Works and FOR (configurable matrix DEC-24) | DSP-02 Must |
| FR-DSP-03 | Owner (vendor, procurement, stores, finance, logistics) and ageing to closure | DSP-03 Must |
| FR-DSP-04 | Upload photos, GRN note, rejection note, shortage report, transporter claim, insurance claim, vendor response | DSP-04 Must |
| FR-DSP-05 | Open dispute on a PO line puts related invoices on hold / partial processing per rule | 3WM-07 Must |
| FR-DSP-06 | Phone camera capture | DER Must |
| FR-DSP-07 | Closure outcome: replacement, credit note, debit note, transporter claim, insurance claim, accepted as-is, claim rejected; closure approval rule [Q] | DER Must |

States: ASN Draft → Submitted → In transit → Delivered (GRN posted) | Cancelled. Dispute: Raised → Assigned → Awaiting response → Under resolution → Resolved (outcome) → Closed | Reopened.
NTF-21 ASN created (stores, buyer), NTF-22 dispute raised/assigned, NTF-23 dispute ageing escalation. RPT-08 dispute ageing.
ACs: AC-ASN-01 missing LR/AWB blocks (if mandatory per terms [Q]); AC-ASN-02 Ex-Works PO → terms/risk prefilled; AC-ASN-03 overdue Equipcare pickup alerts buyer and logistics; AC-DSP-01 "damage" + 3 phone photos creates dispute with evidence; AC-DSP-02 FOR transit damage → vendor owner, Ex-Works → logistics; AC-DSP-03 10-day dispute in correct ageing bucket with owner; AC-DSP-04 open dispute on line 2 → invoice for that line on hold with reason visible to finance.
Screens: SCR-ASN-01 ASN list, SCR-ASN-02 ASN detail, SCR-ASN-03 Expected receipts (stores; primary phone screen at dock), SCR-ASN-04 Discrepancy capture (camera-first; type and qty required; photo required for damage [Q]), SCR-ASN-05 Dispute detail (timeline, evidence, responses, linked invoices; reassign, respond, record outcome, close). Vendor: SCR-VPT-06 ASN create, SCR-VPT-09 disputes.

## 7.9 Module 9 — Vendor portal and onboarding (R1)

| FR | Requirement | Source |
| --- | --- | --- |
| FR-VPT-01 | Vendor login with role-based access, password reset, lock/unlock, admin-controlled user creation | VP-A01 |
| FR-VPT-02 | Profile, contacts, GST/PAN/MSME/bank status, document expiry; changes go to approval, not straight to master data | VP-A02 |
| FR-VPT-03 | View RFQs, download attachments, quote line-wise, upload docs, decline with reason, see submission status | VP-A03 |
| FR-VPT-04 | View POs, acknowledge line-wise, confirm delivery date, submit deviations | VP-A04 |
| FR-VPT-05 | Upload dispatch details, e-way bill, invoice/challan, packing list, LR/AWB, vehicle | VP-A05 |
| FR-VPT-06 | Upload invoice against PO/GRN/ASN and track validation status | VP-A06 |
| FR-VPT-07 | Invoice status, payment status, payment advice, deductions, TDS, advance adjustment as permitted | VP-A07 |
| FR-VPT-08 | Respond to shortage, damage, transit loss, accidental loss disputes with documents | VP-A08 |
| FR-VPT-09 | Tickets: login/access, RFQ access, PO visibility, invoice upload, payment query, document issue, dispute clarification; routed to the right internal team | VP-A09 |
| FR-VPT-10 | Notifications by e-mail, SMS, WhatsApp per final policy | VP-A10, DEC-14 |
| FR-VPT-11 | Onboarding/KYC: invitation → vendor submits company, GST, PAN, MSME, bank, documents → procurement and finance review → approval → SAP vendor creation via SAP process → SAP code linked → full access | BRD Sec 4 |
| FR-VPT-12 | Remind before KYC expiry; expired mandatory documents restrict new RFQ invitations | |
| FR-VPT-13 | Vendor proposes capability rows; procurement approves before use in RFQ-02 suggestions | |
| FR-VPT-14 | Data isolation server-side by vendor code; internal remarks never shown | GOV-C08/C09 |
| FR-VPT-15 | Multiple users per vendor with vendor-level roles (sales, dispatch, accounts) | REC [Q] |

SAP holds the legal vendor record; platform holds onboarding docs, KYC status, portal users, capability mapping. Master fields flow SAP → platform only; requested changes (e.g. bank) are reviewed and passed to SAP team; platform shows new value only after SAP sync. Bank changes need finance approval and are high-risk audit events. MFA one-time code; lockout after N failures. Vendor blocked in SAP keeps read access to open invoices/payments but gets no new RFQs/POs [ASM].
States: onboarding Invited → Registration in progress → Submitted → Under review → Clarification requested → Approved → Pending SAP code → Active | Rejected. Portal user Active → Locked → Deactivated.
NTF-24 onboarding status, NTF-25 document expiry, NTF-26 ticket update.
ACs: AC-VPT-01 5 failed logins lock; admin unlocks with audit; AC-VPT-02 vendor A requesting vendor B's PO by URL/API → not-found and logged; AC-VPT-03 GST certificate expiring in 30 days → vendor and procurement notified; AC-VPT-04 bank change: master unchanged until finance approves and SAP sync returns value; AC-VPT-05 payment-query ticket routes to finance, vendor sees updates; AC-VPT-06 internal remark not shown to vendor; AC-VPT-07 vendor dispute response notifies owner and appears on timeline; AC-VPT-08 e-mail + in-app only policy: no SMS/WhatsApp attempted.
Screens: SCR-VPT-01 vendor home (open RFQs, POs to acknowledge, invoices with exceptions, payments), SCR-VPT-02 profile & KYC, SCR-VPT-03 RFQ inbox, SCR-VPT-04 quote entry (line-by-line stepper on phone), SCR-VPT-05 PO list & ack, SCR-VPT-06 ASN create, SCR-VPT-07 invoice upload & status, SCR-VPT-08 payments & advice, SCR-VPT-09 disputes, SCR-VPT-10 tickets, SCR-VPT-11 registration & onboarding (stepper; GSTIN/PAN format).

## 7.10 Module 10 — Invoice OCR and 3-way match (R4; upload & status from R1)

| FR | Requirement | Source |
| --- | --- | --- |
| FR-INV-01 | Vendor uploads invoice PDF/image against PO/ASN/GRN; linked to vendor and PO | OCR-01 |
| FR-INV-02 | Extract invoice no., date, vendor GSTIN, buyer GSTIN, PO no., line material/service, HSN/SAC, qty, rate, taxable value, GST rate, GST amount, total, e-way bill, bank details | OCR-02 |
| FR-INV-03 | Duplicate invoice number per vendor (normalised: case, spaces, leading zeros) within financial year [Q] | OCR-03 |
| FR-INV-04 | Validate GSTIN (structure + check digit), PAN in GSTIN = vendor PAN, PO number, vendor code mapping, format | OCR-04 |
| FR-INV-05 | Exception queue when any critical field confidence below threshold or validation fails | OCR-05 |
| FR-INV-06 | Authorised users correct fields: old, new, user, time, reason | OCR-06, GOV-C06 |
| FR-INV-07 | Store original file, extracted, corrected and final validation result; immutable after posting | OCR-07 |
| FR-INV-08 | Configurable field confidence thresholds; side-by-side image with highlighted fields | DER |
| FR-INV-09 | Extracted bank details vs SAP vendor bank; mismatch = high-severity exception, never auto-cleared | |
| FR-INV-10 | Finance uploads on vendor's behalf, marked as such | [Q] |
| FR-INV-11 | 3WM-01 PO vs invoice: vendor code, PO no., item, rate, tax, payment terms, value within tolerance | |
| FR-INV-12 | 3WM-02 GRN/SES vs invoice: invoice qty/value ≤ received + tolerance; show short receipt, excess billing, pending GRN | |
| FR-INV-13 | 3WM-03 PO vs GRN/SES: GRN against correct PO line and material; flag wrong mapping | |
| FR-INV-14 | 3WM-04 Tax: GST rate, HSN/SAC, tax value vs PO | |
| FR-INV-15 | 3WM-05 Freight/other charges vs PO terms or approved deviation; unapproved charges on hold | |
| FR-INV-16 | 3WM-06 Advance adjustment: show adjusted amount and balance payable; report unadjusted advance | |
| FR-INV-17 | 3WM-07 Dispute hold: invoices on open disputes on hold / partial per rule; finance sees reason | |
| FR-INV-18 | FDS price check: rate = price list × (1 − discount) within tolerance | CON-05 |
| FR-INV-19 | Never auto-post; park/post only after Matched or exceptions approved by authorised finance user | Must |

Finance control: parking in SAP vs manual is DEC-06; tolerances configured only after joint approval (GOV-C07, DEC-07); until approved tolerance = 0. Service invoices: PO vs SES vs invoice.
States (shared with M11, PAY-01): Uploaded → OCR pending → Validation pending → Exception (sub-reason) → Matched → Parked → Posted → Payment due → Payment released; side Payment blocked; dispute hold is an Exception sub-reason.
NTF-27 invoice received, NTF-28 exception (owner + vendor-safe wording to vendor), NTF-29 exception ageing.
ACs: AC-INV-01 PDF against PO links vendor+PO and stores file; AC-INV-02 every OCR-02 field populated or "not found", accuracy reported; AC-INV-03 "INV-001" then "inv 001" for same vendor → duplicate, blocked; AC-INV-04 bad GSTIN check digit → exception "GSTIN invalid"; AC-INV-05 correction audit shows old/new/user/time/reason; AC-INV-06 rate 2% above PO with 1% tolerance → "price variance"; AC-INV-07 GRN 80 invoice 100 → "excess billing"; AC-INV-08 freight not in PO terms → on hold; AC-INV-09 advance 50,000 → adjusted and balance; unadjusted listed; AC-INV-10 no SAP parking call without finance approval; AC-INV-11 posted invoice: original, extracted, corrected, final retrievable and not editable; AC-INV-12 GRN on line 1 billed against line 2 → "PO/GRN line mismatch"; AC-INV-13 GST 12% vs 18% or HSN differs → "tax mismatch"; AC-INV-14 tolerance change pending until finance+procurement approve.
Screens: SCR-INV-01 invoice list, SCR-INV-02 exception queue (by reason, owner, age), SCR-INV-03 invoice review (image beside extracted fields with confidence; PO, GRN/SES, match results; correct (reason), approve exception, reject, send for parking), SCR-VPT-07 vendor upload & status (vendor-safe exception reasons).

## 7.11 Module 11 — Payment and advance tracking (R4)

FR-PAY-01 invoice status list (above). FR-PAY-02 advance request against PO/contract: amount, reason, approval, payment date, adjustment status. FR-PAY-03 advance outstanding by vendor, PO, ageing. FR-PAY-04 payment advice to vendor after release. FR-PAY-05 deductions, debit notes, TDS, retention as available from SAP (hide, not zero, if SAP doesn't provide). FR-PAY-06 advance requests via Module 5; payment executed in SAP and date synced. FR-PAY-07 vendor payment fields from approved whitelist; internal remarks/block reasons only in vendor-safe wording (DEC-19).
Rules: payment due from SAP; advance adjusted when SAP clears it; partial shows balance. States: Requested → Pending approval → Approved → Paid (SAP) → Partially adjusted → Fully adjusted | Rejected | Cancelled.
NTF-30 payment released (vendor), NTF-31 advance ageing. RPT-10. ACs: AC-PAY-01 SAP posting → Posted for internal and vendor; AC-PAY-02 advance without reason blocked; AC-PAY-03 advances aged 10/40/100 in configured buckets; AC-PAY-04 advice downloadable; AC-PAY-05 TDS shown when SAP provides, hidden otherwise.
Screens: SCR-PAY-01 payment status & advances (finance, buyer), SCR-PAY-02 advance request (amount ≤ PO value), SCR-VPT-08 vendor payments & advice.

## 7.12 Module 12 — SAP integration and monitoring

Integration matrix: INT-M01 vendor master SAP→S2P; M02 material/service; M03 PR; M04 stock/open PO/VMI; M05 RFQ/quotation reference (DEC-04); M06 contract/ARC/OA SAP↔S2P (write per DEC-03); M07 PO; M08 PO acknowledgement S2P→SAP/Z-table (DEC-25); M09 ASN S2P→SAP/repository; M10 GRN/SES; M11 invoice parking S2P→SAP (DEC-06); M12 invoice/payment status.
FR-SAP-01 implement flows; 02 adapter layer, versioned contracts; 03 idempotency key on outbound writes — replay never duplicates; 04 inbound upsert by SAP key, out-of-order detection; 05 error queue with payload, error, attempts; retry with back-off for transient, none for business errors; 06 SAP/IT can view, correct, replay or discard (audited); 07 daily reconciliation counts and totals per object; 08 integration dashboard: last run, success/failure counts, queue depth, freshness; alerts; 09 freshness indicator on business screens; 10 manual recovery runbook per flow (re-sync document, date range, full object); 11 credentials in secrets store; 12 SAP unavailable → platform usable, writes queued, banner.
ACs: AC-SAP-01 released PO appears within freshness; AC-SAP-02 write that timed out after SAP committed → retry gives one SAP document; AC-SAP-03 business error → queue, no retry, SAP/IT alerted; AC-SAP-04 seeded difference of one GRN line → reconciliation lists it; AC-SAP-05 SAP offline → vendor ack saved, write queued and processed when SAP returns.
Screens: SCR-SAP-01 integration monitor, SCR-SAP-02 error queue & replay (replay, discard with reason), SCR-SAP-03 reconciliation (SAP vs platform differences; re-sync).

## 8. Workflows

WF-01 standard PR-to-PO: PR sync → buyer → checks → route → RFQ published to suggested vendors → line-wise quotes → close/lock → comparison/landed cost → recommendation → approval (returned → back; rejected → cancel/re-float) → PO created & released in SAP (or draft PO per DEC-05) → published to portal → vendor acknowledges. Alternates: no responses → extend/re-float; stock found → close line with reason; PO not created in SAP within threshold after approval → buyer alert; SAP sync failure → error queue.
WF-02 ARC/OA/FDS/VMI: valid contract shown → buyer confirms → PO creation reference → PO in SAP with contract reference → utilisation updates; VMI replenishment per terms. Alt: not using contract → reason + off-contract approval → WF-03; contract expired between check and PO → re-check blocks.
WF-03 spot RFQ: as WF-01 for lines without contract; system records that no contract existed at RFQ creation.
WF-04 emergency/BD/Class 1: priority queue with SLA; RFQ with short closing or limited vendors; deviation recorded and approved; PO in SAP; priority reminders. Alt: PO after receipt → exception approval + register.
WF-05 multi-PR RFQ: select lines across PRs; grouping rules; block lines already in active RFQs; one RFQ, lines keep PR links; vendors may skip lines; comparison per line; split award by line.
WF-06 vendor onboarding: existing SAP vendors → admin creates portal user; new vendors → invitation → registration → documents → review → approval → SAP team creates vendor master → code links → capability approved → eligible for suggestions. Alt: clarification → resubmit; rejection with reason.
WF-07 PO ack and delivery tracking: published → vendor ack with commitments (else reminders, deemed acceptance) → dispatch reminder → ASN → delays with reason and history → escalation → GRN closes line. Alt: vendor rejects line → buyer re-sources or amends.
WF-08 ASN and receipt discrepancy: ASN → expected receipts → material arrives → GRN in SAP for accepted qty → discrepancy recorded with evidence (phone) → owner by delivery term → responses, outcome, invoices held.
WF-09 invoice upload and OCR: upload → scan → OCR with confidence → duplicate & identity validation → above threshold → validation pending, else exception → finance corrects with reason. Failure: unreadable → re-upload; OCR down → OCR pending and retried.
WF-10 3-way match: rule order dispute hold, PO vs invoice, GRN/SES vs invoice, PO vs GRN mapping, tax, freight/charges, advance. Each failure → exception with reason and owner (price/terms → buyer; qty/GRN → stores or buyer; tax → finance with procurement; dispute → dispute owner). Resolution: correct data (audited), credit note, approve within authority, reject to vendor with vendor-safe reason. Matched invoice needs finance approval before parking/posting.
WF-11 payment and advance: advance request → approval → paid in SAP → matching shows advance and balance → SAP clears → partial/full adjusted → payment advice to vendor. Alt: unadjusted beyond bucket → NTF-31.
WF-12 contract renewal and off-contract: daily job finds contracts within lead time → owner chooses renew (sourcing or negotiation), extend in SAP, or let expire with reason → renewed contract syncs and replaces old for routing; off-contract alerts require reason and approval.
WF-13 PO amendment/cancellation: buyer request (or vendor deviation) with reason and changed values → approval → changed/cancelled in SAP → amended PO synced with new version → vendor re-acknowledges → commitments and reminders reset. Price amendment always needs approval; cancellation after ASN or partial GRN needs stores and vendor confirmation; "Change pending in SAP" until SAP version arrives.
WF-14 dispute resolution: from receipt or invoice exception → default owner by matrix (reassign with reason) → vendor responds with documents → outcome → linked invoices released/adjusted → closed; escalation beyond threshold (NTF-23).

## 9. AI

Only OCR extraction (AI-02) is required (simulated in this MVP: label it). Everything else is deterministic rules. AI-01, 03–07 are [ENH] proposals — list them as "Proposed — not enabled". No AI output approves, posts, pays, blocks or changes master data.

## 10.3 Screen inventory (ids to use in PageHeader `screen`)

SCR-PLT-01 role home · 02 notification centre · 03 global search · 04 profile. SCR-PRW-01..04. SCR-RFQ-01 RFQ builder (lines, suggested vendors with reasons, terms, attachments, closing date; desktop/tablet) · 02 RFQ detail & participation (extend, cancel, re-float, remind) · 03 RFQ list. SCR-CMP-01 comparative statement (line × vendor grid: basic, discount, GST, freight, packing, landed, LPP, contract price, variance, lowest highlighted, coverage; export PDF/Excel; phone: per-line cards with vendors ranked) · 02 award recommendation. SCR-APR-01..03. SCR-CON-01..04. SCR-POM-01..03. SCR-ASN-01..05. SCR-VPT-01..11. SCR-INV-01..03. SCR-PAY-01..02. SCR-SAP-01..03. SCR-RPT-01..12 reports. SCR-ADM-01 users & roles (create, lock, unlock, deactivate; SoD conflicts warned) · 02 business configuration (routes, reminders, tolerances, approval matrix, SLAs with effective dates; versioned; approval for tolerance changes) · 03 master mappings (buyer matrix, spend categories, capability approvals) · 04 audit log viewer.

## 13. Reports (standard filters: date range, plant, category, buyer, vendor, priority, route)

Every metric drills to records and reconciles with the list; shows data as-of and SAP freshness; export CSV/PDF (audited). Vendors see only own scorecard and approved metrics [Q].
RPT-01 PR ageing & buyer workload (buyer, plant, material group, priority, route; open count, buckets, assigned/unassigned). RPT-02 RFQ coverage (floated, invited, responded, declined, non-participating, below-minimum RFQs). RPT-03 quotation & approval cycle time (RFQ-to-quote, comparison time KPI-04, approval ageing KPI-05, rework). RPT-04 open PO (vendor, buyer, plant, material, urgency; open qty, delivery date, commitment, delay reason, overdue). RPT-05 vendor follow-up (pending ack, pending dispatch, reminder count, latest response, next action). RPT-06 ARC/OA opportunity. RPT-07 contract coverage (spend under ARC/OA/FDS/VMI vs spot, KPI-08/09). RPT-08 dispute ageing (type, owner, vendor, delivery term; count, value, ageing, closure TAT KPI-12). RPT-09 invoice OCR & 3WM (uploaded, OCR success, match success KPI-11, exception reasons, pending, parked/posted, field accuracy KPI-10). RPT-10 advance payment (requested, approved, paid, adjusted, outstanding KPI-15). RPT-11 vendor performance scorecard (RFQ response, ack TAT, delivery adherence, disputes, invoice accuracy; composite KPI-13 with weights DEC-22). RPT-12 user requirement status.
KPIs: KPI-01 PR-to-RFQ TAT (median/P90 RFQ release − buyer assignment); KPI-02 PR-to-PO TAT (PO date − PR available); KPI-03 RFQ response rate (quoted ÷ invited); KPI-04 comparison TAT (RFQ close → comparison submitted); KPI-05 approval ageing; KPI-06 PO ack TAT (ack − publication); KPI-07 on-time delivery (GRN date ≤ committed ÷ lines received); KPI-08 contract coverage (PO value under ARC/OA/FDS/VMI ÷ total); KPI-09 spot dependency; KPI-10 OCR field accuracy (unchanged by reviewer ÷ extracted); KPI-11 3WM success (matched without exception ÷ uploaded); KPI-12 dispute closure TAT; KPI-13 vendor score; KPI-14 buyer productivity (lines processed per buyer; coaching not ranking); KPI-15 advance outstanding ageing. No baselines or targets set — show "Baseline: to be measured" / "Target: pending approval".

## 14. Notifications

In-app always; e-mail default; SMS/WhatsApp per DEC-14 (off); push optional. Dedupe per (event, record, recipient) window; escalation level 1 owner → 2 manager → 3 department head (matrix [Q]). Mandatory events cannot be switched off.
NTF-01 PR assigned · 02 PR ageing breach · 03 PR clarification · 04 RFQ invitation · 05 RFQ closing reminder · 06 RFQ extended/cancelled/re-floated · 07 RFQ closed / missing quotations · 08 quotation received · 09 RFQ reopened · 10 approval request · 11 approval pending beyond threshold · 12 approval decision · 13 contract expiring · 14 off-contract detected · 15 VMI below minimum · 16 PO published · 17 PO ack pending · 18 dispatch due / delivery overdue · 19 delay escalation · 20 PO amended/cancelled · 21 ASN submitted · 22 dispute raised/assigned · 23 dispute ageing · 24 onboarding status · 25 KYC document expiring · 26 ticket update · 27 invoice received · 28 invoice exception · 29 exception ageing · 30 payment released · 31 advance ageing · 32 integration failure · 33 SAP freshness breached.

## 18. Open decisions (show as DecisionTag where a rule depends on them)

DEC-01 deployment model · DEC-02 commercial model · DEC-03 SAP integration depth (write-back) · DEC-04 RFQ ownership (SAP vs portal) · DEC-05 PO creation authority (SAP only vs draft PO from award) · DEC-06 OCR automation level (validate only vs park) · DEC-07 3WM tolerances · DEC-08 vendor onboarding strategy · DEC-09 ARC/OA governance & thresholds · DEC-10 change management · DEC-11 data residency & retention · DEC-12 security (SSO, MFA) · DEC-13 approval authority matrix · DEC-14 notification policy · DEC-15 SLA & calendar · DEC-16 deemed acceptance · DEC-17 SAP version & interfaces · DEC-18 late/risk discount definitions · DEC-19 vendor-facing payment fields · DEC-20 dispute payment hold rule · DEC-21 landed-cost components · DEC-22 scorecard weights & vendor visibility · DEC-23 NFR targets · DEC-24 delivery-term responsibility matrix · DEC-25 PO acknowledgement record in SAP.
