process.env.S2P_NO_LISTEN = '1';
const { all } = await import('../server/core/db.ts');
const sql = process.argv.slice(2).join(' ');
console.table(all(sql));
