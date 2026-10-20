/**
 * Canonical status vocabularies (PRD Sec 7 workflow states). Every module writes exactly these
 * strings so dashboards, reports, nav counts and the shared status badges stay consistent.
 */
export const STATUS = {
  prLine: ['Synced', 'Unassigned', 'Assigned', 'Under review', 'Clarification pending', 'On hold', 'Route decided', 'Exception pending approval', 'RFQ in progress', 'Contract/VMI PO pending', 'PO created', 'Closed', 'Cancelled in SAP'],
  rfq: ['Draft', 'Pending approval', 'Published', 'Closed', 'Under comparison', 'Awarded', 'Cancelled', 'Re-floated'],
  invitation: ['Invited', 'Viewed', 'Responded', 'Declined', 'Not responded'],
  quotation: ['Not started', 'Draft', 'Submitted', 'Locked', 'Reopened', 'Final', 'Declined'],
  comparison: ['Draft', 'Recommendation recorded', 'Submitted for approval', 'Approved', 'Returned', 'Rejected', 'Released for PO'],
  approval: ['Pending', 'Clarification requested', 'Approved', 'Rejected', 'Returned', 'Withdrawn'],
  contract: ['Draft', 'Pending approval', 'Pending SAP', 'Active', 'Expiring', 'Expired', 'Renewed', 'Terminated'],
  opportunity: ['Identified', 'Under review', 'Accepted', 'Rejected'],
  po: ['Published', 'Partially received', 'Closed', 'Cancelled'],
  poLineAck: ['Pending', 'Accepted', 'Partially accepted', 'Rejected', 'Deemed accepted', 'Pending re-acknowledgement', 'Cancelled'],
  poLine: ['Published', 'In dispatch', 'Partially received', 'Received', 'Closed', 'Cancelled'],
  amendment: ['Requested', 'Approved', 'Rejected', 'Changed in SAP', 'Republished', 'Re-acknowledged', 'Withdrawn'],
  asn: ['Draft', 'Submitted', 'In transit', 'Delivered', 'Cancelled'],
  dispute: ['Raised', 'Assigned', 'Awaiting response', 'Under resolution', 'Resolved', 'Closed', 'Reopened'],
  invoice: ['Uploaded', 'OCR pending', 'Validation pending', 'Exception', 'Matched', 'Parked', 'Posted', 'Payment due', 'Payment released', 'Payment blocked', 'Rejected'],
  invoiceException: ['Open', 'Resolved', 'Approved', 'Rejected'],
  advance: ['Requested', 'Pending approval', 'Approved', 'Paid', 'Partially adjusted', 'Fully adjusted', 'Rejected', 'Cancelled'],
  ticket: ['Open', 'In progress', 'Awaiting vendor', 'Resolved', 'Closed'],
  vendorOnboarding: ['Invited', 'Registration in progress', 'Submitted', 'Under review', 'Clarification requested', 'Approved', 'Pending SAP code', 'Active', 'Rejected'],
  vendorPortal: ['Not invited', 'Invited', 'Registration submitted', 'Active', 'Locked', 'Deactivated'],
  vendorChange: ['Pending', 'Approved', 'Rejected', 'Sent to SAP', 'Applied'],
  capability: ['Proposed', 'Approved', 'Rejected'],
} as const;
