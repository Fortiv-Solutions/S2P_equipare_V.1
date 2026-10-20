"""Dev helper: open record detail pages (ids read from the database) and report problems.
Usage: python scripts/crawl_details.py [width]
Administrator: every RFQ, comparison, contract, ASN, dispute, vendor, ticket and advance; samples of PR lines, approvals, POs and invoices
(spread over every status). Vendor portal: PO / RFQ / invoice / dispute / ASN detail for three vendors. Reports console errors,
API responses >= 400, error screens and (phone widths) horizontal overflow."""
import sqlite3, sys, os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("SHOT_BASE", "http://localhost:5173")
WIDTH = int(sys.argv[1]) if len(sys.argv) > 1 else 1440
DB = os.environ.get("S2P_DB", "data/s2p.db")
BAD_TEXT = ["This could not load", "This screen hit an error", "Page not found", "Something went wrong"]

db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
def ids(sql, *p): return [r[0] for r in db.execute(sql, p).fetchall()]
def spread(table, col, per=3, extra=""):
    out = []
    for (st,) in db.execute(f"select distinct {col} from {table} {extra}").fetchall():
        out += ids(f"select id from {table} where {col} = ? {('and ' + extra[6:]) if extra else ''} order by id limit {per}", st)
    return out

admin = (
    [f"/pr/{i}" for i in spread("pr_lines", "status", 2)]
    + [f"/rfqs/{i}" for i in ids("select id from rfqs order by id")]
    + [f"/comparisons/{i}" for i in ids("select id from comparisons order by id")]
    + [f"/approvals/{i}" for i in spread("approvals", "status", 4)]
    + [f"/contracts/{i}" for i in ids("select id from contracts order by id")]
    + [f"/pos/{i}" for i in spread("pos", "status", 5)]
    + [f"/asns/{i}" for i in ids("select id from asns where status != 'Draft' order by id")]  # drafts are the vendor's until submitted
    + [f"/disputes/{i}" for i in ids("select id from disputes order by id")]
    + [f"/invoices/{i}" for i in spread("invoices", "status", 3)]
    + [f"/vendors/{i}" for i in ids("select id from vendors order by id")]
    + [f"/tickets/{i}" for i in ids("select id from tickets order by id")]
    + [f"/advances/{i}" for i in ids("select id from advances order by id")]
)

def vendor_paths(vid):
    p = [f"/vendor/pos/{i}" for i in ids("select id from pos where vendor_id=? order by id desc limit 4", vid)]
    p += [f"/vendor/rfqs/{i}" for i in ids("select r.id from rfqs r join rfq_invitations i on i.rfq_id=r.id where i.vendor_id=? and r.status != 'Draft' order by r.id desc limit 4", vid)]
    p += [f"/vendor/invoices/{i}" for i in ids("select id from invoices where vendor_id=? order by id desc limit 4", vid)]
    p += [f"/vendor/disputes/{i}" for i in ids("select d.id from disputes d join pos p on p.id=d.po_id where p.vendor_id=? order by d.id desc limit 3", vid)]
    p += [f"/vendor/asns/{i}" for i in ids("select id from asns where vendor_id=? order by id desc limit 3", vid)]
    return p

VENDORS = ["100101", "100102", "100104"]
problems = []

with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": WIDTH, "height": 900})
    pg = ctx.new_page()
    cur = {"errs": [], "bad": []}
    pg.on("console", lambda m: cur["errs"].append(m.text[:200]) if m.type == "error" and "Failed to load resource" not in m.text else None)
    pg.on("pageerror", lambda e: cur["errs"].append("PAGEERROR " + str(e)[:200]))
    pg.on("response", lambda r: cur["bad"].append(f"{r.status} {r.request.method} {r.url.split('/api')[-1][:90]}") if "/api/" in r.url and r.status >= 400 else None)
    api = ctx.request

    def visit(label, path):
        cur.update(errs=[], bad=[])
        pg.goto(BASE + path, wait_until="domcontentloaded"); pg.wait_for_timeout(1300)
        body = pg.inner_text("body")
        issues = [f"screen: {t}" for t in BAD_TEXT if t in body]
        ov = pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        if ov > 4 and WIDTH < 1100: issues.append(f"overflow {ov}px")
        issues += ["console: " + e for e in cur["errs"][:2]] + ["api: " + e for e in cur["bad"][:3]]
        if issues:
            print(f"BAD {label:14} {path} -> " + " | ".join(issues)); problems.append((label, path))
        return not issues

    api.post(BASE + "/api/auth/switch-role", data={"role": "ADM"})
    ok = sum(visit("admin", p) for p in admin)
    print(f"administrator: {ok}/{len(admin)} detail pages clean")

    vs = api.get(BASE + "/api/auth/acting-vendors").json()
    for code in VENDORS:
        v = next(x for x in vs if x["sap_code"] == code)
        api.post(BASE + "/api/auth/switch-role", data={"role": "VEN", "vendor_id": v["id"]})
        paths = vendor_paths(v["id"])
        ok = sum(visit(f"vendor {code}", p) for p in paths)
        print(f"vendor {code}: {ok}/{len(paths)} detail pages clean")
    api.post(BASE + "/api/auth/switch-role", data={"role": "ADM"})
    b.close()
print(f"\n{len(problems)} detail page(s) with problems")
