"""Dev helper: screenshot pages of the single-user app (no sign-in).
Usage: python scripts/shot.py <vendor-sap-code|-> <outdir> <path>[,<path>...] [width]
The first argument chooses the workspace: - = Administrator, or a vendor SAP code to open the vendor portal as that vendor."""
import sys, re, os
BASE = os.environ.get("SHOT_BASE", "http://localhost:5173")
from playwright.sync_api import sync_playwright
email, out, paths = sys.argv[1], sys.argv[2], sys.argv[3].split(',')
width = int(sys.argv[4]) if len(sys.argv) > 4 else 1440
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={'width': width, 'height': 900})
    errs = []
    reqs = []
    pg.on('request', lambda r: reqs.append(r.url) if '/api/' in r.url else None)
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    ctx_api = pg.context.request
    if email == '-':
        ctx_api.post(BASE + '/api/auth/switch-role', data={'role': 'ADM'})
    else:
        vs = ctx_api.get(BASE + '/api/auth/acting-vendors').json()
        v = next((x for x in vs if x['sap_code'] == email or (email.lower() in x['name'].lower())), None)
        ctx_api.post(BASE + '/api/auth/switch-role', data={'role': 'VEN', 'vendor_id': v['id']})
    for path in paths:
        n0=len(reqs); pg.goto(BASE + '' + path, wait_until='domcontentloaded'); pg.wait_for_timeout(2500)
        name = re.sub(r'[^a-z0-9]+', '_', (('admin' if email == '-' else 'vendor_' + email) + path).lower()).strip('_') + f'_{width}.png'
        pg.screenshot(path=f'{out}/{name}', full_page=True)
        print('shot', name, 'api requests:', len(reqs)-n0, sorted(set(u.split('/api')[1].split('?')[0] for u in reqs[n0:]))[:12])
    for e in errs: print('CONSOLE', e[:300])
    b.close()
