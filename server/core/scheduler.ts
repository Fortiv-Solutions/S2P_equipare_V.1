/**
 * In-process job scheduler for reminders, escalations, expiry checks and scheduled SAP syncs.
 * Every run is logged in `job_runs`; admins can trigger any job manually from the UI.
 */
import { get, insert, run, scalar, update, now } from './db.ts';

export interface JobDef {
  name: string;
  label: string;
  everyMinutes: number;
  run: () => string | void;
}

const jobs = new Map<string, JobDef & { lastRun?: number }>();

export function registerJob(def: JobDef) {
  jobs.set(def.name, def);
}

export function listJobs() {
  return [...jobs.values()].map(({ name, label, everyMinutes, lastRun }) => ({
    name, label, everyMinutes, lastRun: lastRun ? new Date(lastRun).toISOString() : null,
  }));
}

export function runJob(name: string) {
  const j = jobs.get(name);
  if (!j) throw new Error(`Unknown job ${name}`);
  const id = insert('job_runs', { job: name, started_at: now(), status: 'Running' });
  j.lastRun = Date.now();
  try {
    const msg = j.run() ?? 'ok';
    update('job_runs', id, { finished_at: now(), status: 'Succeeded', message: String(msg) });
    return { status: 'Succeeded', message: String(msg) };
  } catch (e) {
    console.error(`job ${name} failed`, e);
    update('job_runs', id, { finished_at: now(), status: 'Failed', message: (e as Error).message });
    return { status: 'Failed', message: (e as Error).message };
  }
}

let timer: NodeJS.Timeout | null = null;
export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    const t = Date.now();
    for (const j of jobs.values()) {
      if (!j.lastRun || t - j.lastRun >= j.everyMinutes * 60000) runJob(j.name);
    }
  }, 30000);
  // First pass shortly after start, so reminders reflect current state.
  setTimeout(() => {
    // On a freshly seeded database every record is already "old", so the first pass would raise one alert per record.
    // Let the jobs run (their state is real) but mark what that pass raised as read, so the inbox opens clean.
    const fresh = get('SELECT key FROM sap_sim_settings WHERE key = ?', 'fresh_seed');
    const from = scalar<number>('SELECT COALESCE(MAX(id), 0) FROM notifications') ?? 0;
    for (const j of jobs.values()) if (!j.lastRun) runJob(j.name);
    if (fresh) {
      run('UPDATE notifications SET read_at = ? WHERE id > ? AND read_at IS NULL', now(), from);
      run('DELETE FROM sap_sim_settings WHERE key = ?', 'fresh_seed');
    }
  }, 5000);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
