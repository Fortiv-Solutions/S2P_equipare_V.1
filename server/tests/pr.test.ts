import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './helpers.ts';

let t: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { t = await startApp(); });
afterAll(async () => { await t.close(); });

const lineId = (pr: string, item = 10) => (t.db.get<{ id: number }>('SELECT id FROM pr_lines WHERE pr_no = ? AND item = ?', pr, item))!.id;

describe('Module 1 — PR workbench', () => {
  it('AC-PRW-01: open SAP PR lines are synchronised with PR-01 fields and a sync time', async () => {
    const amit = await t.login('amit.kulkarni');
    const r = await amit.get(`/api/pr/lines/${lineId('10045501')}`);
    expect(r.status).toBe(200);
    for (const k of ['pr_no', 'item', 'material_code', 'material_group', 'plant', 'storage_location', 'qty', 'required_date', 'priority', 'synced_at']) expect(r.body[k]).toBeTruthy();
  });

  it('AC-PRW-02: a requisitioner sees only their own PR lines', async () => {
    const priya = await t.login('priya.nair');
    const mine = await priya.get('/api/pr/mine');
    expect(mine.status).toBe(200);
    expect(mine.body.length).toBeGreaterThan(0);
    const other = await priya.get(`/api/pr/lines/${lineId('10045503')}`); // Rahul's PR
    expect(other.status).toBe(404);
    const list = await priya.get('/api/pr/lines');
    expect(list.body.every((l: any) => l.requisitioner_name === 'Priya Nair')).toBe(true);
  });

  it('AC-PRW-03: lines are assigned from the buyer matrix; unmapped categories go to the unassigned queue', async () => {
    const r = t.db.get<{ buyer_id: number | null; status: string }>('SELECT buyer_id, status FROM pr_lines WHERE pr_no = ?', '10045514');
    expect(r?.status).toBe('Unassigned');
    const vikram = await t.login('vikram.joshi');
    const sneha = t.db.get<{ id: number }>("SELECT id FROM users WHERE email LIKE 'sneha.patil@%'")!.id;
    const first = await vikram.post(`/api/pr/lines/${lineId('10045514')}/assign`, { buyer_id: sneha });
    expect(first.status).toBe(200);
    const amit = t.db.get<{ id: number }>("SELECT id FROM users WHERE email LIKE 'amit.kulkarni@%'")!.id;
    const noReason = await vikram.post(`/api/pr/lines/${lineId('10045514')}/assign`, { buyer_id: amit });
    expect(noReason.status).toBe(400);
  });

  it('AC-PRW-04/05: checks must run before routing; a valid OA proposes ARC/OA and overriding needs reason + approval', async () => {
    const amit = await t.login('amit.kulkarni');
    const id = lineId('10045502');
    const early = await amit.post(`/api/pr/lines/${id}/route`, { route: 'RFQ', reason: 'Testing before checks run' });
    expect(early.status).toBe(409);
    const c = await amit.post(`/api/pr/lines/${id}/checks`);
    expect(c.status).toBe(200);
    expect(c.body.route_proposed).toBe('ARC/OA');
    expect(c.body.checks.contract.valid).toBe(true);
    const bad = await amit.post(`/api/pr/lines/${id}/route`, { route: 'RFQ' });
    expect(bad.status).toBe(400);
    const ok = await amit.post(`/api/pr/lines/${id}/route`, { route: 'RFQ', reason: 'Quality issues with ARC vendor this quarter' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('Exception pending approval');
    const ap = t.db.get<{ type: string; category: string }>("SELECT type, category FROM approvals WHERE object_type = 'pr_line' AND object_id = ?", id);
    expect(ap).toMatchObject({ type: 'exc.off_contract', category: 'exception' });
  });

  it('AC-PRW-08: repeat purchases without ARC/OA are flagged', async () => {
    const r = t.db.get<{ repeat_flag: number }>('SELECT repeat_flag FROM pr_lines WHERE pr_no = ? AND item = 10', '10045501');
    expect(r?.repeat_flag).toBe(1);
  });

  it('FR-PLT-03: a vendor cannot call PR endpoints', async () => {
    const manoj = await t.login('manoj.kale');
    expect((await manoj.get('/api/pr/lines')).status).toBe(403);
  });
});
