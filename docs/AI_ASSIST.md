# AI assistance layer

Positioning: SAP records. This app collects, decides, chases and explains. Nothing here posts to SAP, approves, pays,
or changes a match result or a tolerance.

| Feature | Where | How it works | AI model? |
| --- | --- | --- | --- |
| Delivery risk | PO detail → *Delivery risk*; home *At risk* | Score = sum of named factors (days late, no ASN, not acknowledged, moved commitments, reminders without a reply, vendor on-time record, urgency, escalation). Weights are a proposed default; bands in `insights.risk_bands`. | No |
| One-click reminder | Risk card | Sends the same portal reminder as *Remind vendor* (shared wording in `reminderContent`), then logs the suggestion and the decision. Not offered twice the same day. | No |
| Vendor reply reading | PO detail → *Read the vendor's reply* | Finds explicit dates (ISO, dd/mm/yyyy, "15 Nov", weekdays, "in 3 days") and a delay reason by keywords. Never guesses from vague words. The buyer confirms the date and reason before anything is recorded. | No |
| Invoice explanation | Invoice review → *What is wrong, and what to do* | Each 3-way match finding becomes "what it means / who owns it / what to do", plus a recommended first step. Findings and tolerances stay with the match engine. | Optional: rewords the summary paragraph |
| Ask the data | Home | Keyword and filter rules over read-only queries (late POs, held invoices, payments due, approvals, RFQs, contracts, PR lines, disputes, advances, a vendor). Says how it understood the question. | No |
| Act now / workspaces | Home, Sourcing, Delivery, Finance | Existing work queues plus a next-step line per kind of work. | No |

## Optional model wording

Off by default. Needs both: `ANTHROPIC_API_KEY` on the server and the business rule *AI-worded summaries* (`ai.model_wording`) on.
Only computed facts (vendor name, invoice number, totals, reasons, expected/actual values, ages) are sent. No documents,
bank details or free text. A reply is used only if every number in it appears in the facts; otherwise, and on any error or
timeout, the rules text is shown and labelled *Rules*. Output that was model-worded is labelled *AI-worded*.

## Log

Administration → AI assistance lists every suggestion a person accepted, edited or dismissed, the score, the source and the
outcome. Each decision is also an audit event (`ai.suggestion_accepted|edited|dismissed`).

## Open decisions

- Q AI-1: whether a model may be used at all, and where it may run (cloud or on-premise).
- Q AI-2: risk weights and bands.
