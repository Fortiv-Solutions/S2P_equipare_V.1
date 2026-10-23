// Vercel serverless entry: runs the Express API as one function (demo mode).
// The filesystem is read-only apart from /tmp, so the SQLite database and uploads live there and are
// re-seeded on every cold start: changes do not persist, and the scheduler does not run.
process.env.S2P_DATA_DIR ??= '/tmp/s2p';
process.env.S2P_NO_LISTEN = '1';
process.env.S2P_NO_SCHEDULER = '1';
// Single-user mode answers only on allowed hosts; add this deployment's Vercel domains.
process.env.S2P_ALLOWED_HOSTS = [
  process.env.S2P_ALLOWED_HOSTS,
  process.env.VERCEL_URL,
  process.env.VERCEL_BRANCH_URL,
  process.env.VERCEL_PROJECT_PRODUCTION_URL,
].filter(Boolean).join(',');

// Env must be set before the server's modules evaluate, hence the dynamic import.
const { app } = await import('../api-dist/server.mjs');

export default app;
