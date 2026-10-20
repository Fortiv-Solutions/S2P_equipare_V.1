/**
 * FR-SAP-10 manual recovery runbook per flow. Steps are operational guidance for SAP/IT; every action
 * the runbook offers is a working API call (re-sync one document, re-sync from a date, full re-sync,
 * process the outbound queue).
 */
export interface RunbookEntry {
  flow: string;
  symptoms: string[];
  checks: string[];
  steps: string[];
  keyHint?: string;
}

export const RUNBOOK: RunbookEntry[] = [
  { flow: 'INT-M01', symptoms: ['Vendor missing or old name/bank in the platform', 'PO or OA sync fails with "Vendor … not found"'], checks: ['Vendor exists and is not marked for deletion in SAP', 'Onboarded vendor PAN/GSTIN matches the SAP master'], steps: ['Re-sync the vendor code (document key = SAP vendor code)', 'Then replay the PO / OA messages that failed in the error queue'], keyHint: 'SAP vendor code, e.g. 100101' },
  { flow: 'INT-M02', symptoms: ['PR line shows "Material is not in the material master"', 'Wrong GST rate or HSN on RFQ lines'], checks: ['Material is extended to the plant in SAP', 'Material group is mapped to a spend category (Administration › Master mappings)'], steps: ['Re-sync the material code', 'Run checks again on the affected PR lines'], keyHint: 'Material code, e.g. HYD-1001' },
  { flow: 'INT-M03', symptoms: ['Released PR not visible in the PR workbench', 'PR line still open after deletion in SAP'], checks: ['PR is released in SAP (release strategy complete)', 'Requisitioner e-mail in SAP matches a platform user'], steps: ['Re-sync the PR number', 'If many PRs are missing, re-sync from the date of the outage'], keyHint: 'PR number, e.g. 10045501' },
  { flow: 'INT-M04', symptoms: ['Stock or open PO check shows stale data', 'VMI below-minimum alert missing'], checks: ['Stock key is material|plant'], steps: ['Re-sync the stock key', 'Full re-sync after a plant stock-take'], keyHint: 'material|plant, e.g. FLT-4002|PUN1' },
  { flow: 'INT-M05', symptoms: ['RFQ reference not in SAP'], checks: ['DEC-04 decides whether SAP holds an RFQ document; until then nothing is written'], steps: ['No action while the write switch is off', 'When enabled: process the queue, then replay failed messages'] },
  { flow: 'INT-M06', symptoms: ['Contract stuck in Pending SAP after the OA was created', 'Expired OA still routes PR lines'], checks: ['OA carries the platform contract number as reference', 'Vendor of the OA exists in the platform'], steps: ['Re-sync the OA number', 'Re-sync from date after bulk OA extensions'], keyHint: 'OA number, e.g. 5500000101' },
  { flow: 'INT-M07', symptoms: ['Released PO not visible to the vendor', 'Amended PO not republished'], checks: ['PO is released in SAP (AC-POM-01: unreleased POs are never published)', 'Vendor master synced (INT-M01)'], steps: ['Re-sync the PO number', 'If the vendor was missing, re-sync INT-M01 first, then the PO', 'Re-sync from date after an outage'], keyHint: 'PO number, e.g. 4500021001' },
  { flow: 'INT-M08', symptoms: ['Acknowledgement saved in the platform but not in SAP'], checks: ['DEC-25: until decided the platform is the record of acknowledgement', 'SAP availability (simulator outage switch)'], steps: ['Process the queue now', 'Replay failed messages from the error queue; replay never creates a second SAP document (idempotency key)'] },
  { flow: 'INT-M09', symptoms: ['ASN not visible to stores'], checks: ['ASN is kept in the platform with the PO reference; no SAP write in this release'], steps: ['No SAP recovery needed; check the ASN status in the platform'] },
  { flow: 'INT-M10', symptoms: ['GRN posted in SAP but PO line still open', 'Invoice shows "pending GRN"', 'Reconciliation lists a GRN line difference'], checks: ['The PO of the GRN exists in the platform (INT-M07)', 'PO item number matches'], steps: ['Re-sync the PO first if it is missing', 'Re-sync the GRN document (key = GRN number-year)', 'Discard with a reason if the GRN was reversed in SAP'], keyHint: 'GRN key, e.g. 5000100201-2026' },
  { flow: 'INT-M11', symptoms: ['Approved invoice not parked in SAP'], checks: ['DEC-06: parking in SAP is off; finance enters approved invoices manually', 'Finance approval exists (AC-INV-10)'], steps: ['Process the queue now when the write is enabled', 'Replay failed messages after correcting the payload'] },
  { flow: 'INT-M12', symptoms: ['Invoice posted or paid in SAP but status unchanged', 'Advance paid in SAP but still Approved'], checks: ['Invoice reference in SAP equals the platform invoice reference', 'Advance number matches'], steps: ['Re-sync the invoice reference (INVSTATUS) or advance number (ADVPAY)', 'Re-sync from date after month-end clearing runs'], keyHint: 'Invoice ref (INVSTATUS) or advance no. (ADVPAY)' },
];
