"""Dev helper: crawl every navigation item of the single-user app and report problems.

Usage: python scripts/crawl.py [width]
Phase 1 visits every rail item as the Administrator. Phase 2 opens the vendor portal as several vendor companies
(Active, and one still onboarding) and visits their navigation. Reports per page: console errors, API responses >= 400,
error screens, and (phone widths) horizontal overflow. Server-side state, so it always switches back to the admin."""
import sys, os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("SHOT_BASE", "http://localhost:5173")
WIDTH = int(sys.argv[1]) if len(sys.argv) > 1 else 1440
BAD_TEXT = ["This could not load", "This screen hit an error", "Page not found", "Something went wrong"]
VENDORS = ["100101", "100102", "100104", "100106", "100108", "ORION"]  # SAP codes; ORION = vendor still onboarding

problems = []

def check(pg, cur, label, path):
    cur.update(errs=[], bad=[])
    pg.goto(BASE + path, wait_until="domcontentloaded"); pg.wait_for_timeout(1800)
    body = pg.inner_text("body")
    issues = [f"screen: {t}" for t in BAD_TEXT if t in body]
    if "Sign in" in body and "Demo accounts" in body: issues.append("sign-in screen shown")
    ov = pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    if ov > 4 and WIDTH < 1100: issues.append(f"overflow {ov}px")
    issues += ["console: " + e for e in cur["errs"][:3]] + ["api: " + e for e in cur["bad"][:4]]
    print(("OK  " if not issues else "BAD ") + f"{label:22} {path}" + ("" if not issues else "  -> " + " | ".join(issues)))
    if issues: problems.append((label, path, issues))

def nav_paths(pg):
    pg.set_viewport_size({"width": 1440, "height": 900}); pg.wait_for_timeout(500)
    paths = [a.get_attribute("href") for a in pg.locator("nav[aria-label=Main] a").all()]
    pg.set_viewport_size({"width": WIDTH, "height": 900})
    return [x for x in dict.fromkeys(paths) if x]

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": WIDTH, "height": 900})
    pg = ctx.new_page()
    cur = {"errs": [], "bad": []}
    pg.on("console", lambda m: cur["errs"].append(m.text[:200]) if m.type == "error" and "Failed to load resource" not in m.text else None)
    pg.on("pageerror", lambda e: cur["errs"].append("PAGEERROR " + str(e)[:200]))
    pg.on("response", lambda r: cur["bad"].append(f"{r.status} {r.request.method} {r.url.split('/api')[-1][:90]}") if "/api/" in r.url and r.status >= 400 else None)

    api = ctx.request
    api.post(BASE + "/api/auth/switch-role", data={"role": "ADM"})
    pg.goto(BASE + "/login", wait_until="domcontentloaded"); pg.wait_for_timeout(1200)
    print("login route lands on:", pg.url.replace(BASE, "") or "/")
    for path in nav_paths(pg):
        check(pg, cur, "administrator", path)

    vendors = {v["sap_code"] or "ORION": v["id"] for v in api.get(BASE + "/api/auth/acting-vendors").json()}
    vendors = {k: v for k, v in vendors.items() if k in VENDORS or (k is None)}
    for name in VENDORS:
        vid = next((v["id"] for v in api.get(BASE + "/api/auth/acting-vendors").json() if (v["sap_code"] == name) or (name == "ORION" and v["sap_code"] is None and "Orion" in v["name"])), None)
        if vid is None: print("skip vendor", name); continue
        api.post(BASE + "/api/auth/switch-role", data={"role": "VEN", "vendor_id": vid})
        pg.goto(BASE + "/", wait_until="domcontentloaded"); pg.wait_for_timeout(1200)
        for path in nav_paths(pg):
            check(pg, cur, f"vendor {name}", path)
    api.post(BASE + "/api/auth/switch-role", data={"role": "ADM"})
    b.close()
print(f"\n{len(problems)} page(s) with problems")
