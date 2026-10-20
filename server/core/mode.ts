/**
 * Deployment mode.
 *
 * Single-user mode (default): no sign-in. One Administrator account holds every internal module and the
 * server always acts as that account. The vendor portal is reached by "acting as" a vendor company.
 * Because only one person exists, segregation of duties (requester ≠ approver) cannot hold; it is waived
 * and every waived decision is recorded in the audit trail.
 *
 * Multi-user mode (`S2P_SINGLE_USER=0`): sessions, per-role accounts, vendor MFA, segregation of duties.
 * This is the PRD's target model; the automated test suite runs in this mode.
 */
export const SINGLE_USER = process.env.S2P_SINGLE_USER !== '0';

/** Whether "the person who raised it cannot approve it" applies (FR-APR-09). */
export const sodApplies = () => !SINGLE_USER;

export const ADMIN_EMAIL = 'admin@equipcare.test';
export const ADMIN_NAME = 'Administrator';
export const SESSION_ID_SINGLE = 'single-user';

/** Extended demo data (a year of history, more RFQs, invoices, disputes …). Off in tests so their known values stay fixed. */
export const DEMO_EXTRA = process.env.S2P_DEMO_EXTRA !== '0';
