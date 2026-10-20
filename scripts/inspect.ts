/** Dev helper: boot the API in-process (no listener) and print a data summary. */
process.env.S2P_NO_LISTEN = '1';
await import('../server/index.ts');
const { all, get } = await import('../server/core/db.ts');
console.log(all('SELECT status, COUNT(*) n FROM pr_lines GROUP BY status'));
console.log(all('SELECT po_no, status, total_value FROM pos ORDER BY po_no').length, 'pos');
console.log(all('SELECT contract_no, type, status, sap_oa_no FROM contracts'));
console.log(get('SELECT COUNT(*) n FROM grns'), get('SELECT COUNT(*) n FROM notifications'), get('SELECT COUNT(*) n FROM integration_errors'));
console.log(all("SELECT flow, message_id, error FROM integration_errors"));
console.log(all('SELECT flow,last_status,last_message FROM sync_state'));
process.exit(0);
