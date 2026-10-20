# Brief for module engineers (read fully before writing code)

You are one of eight engineers building modules of the Knowteq Equipcare Source-to-Pay platform in parallel,
in `D:\Downloads\S2P` (Windows; Git Bash and PowerShell are both available). The lead built the foundation:
core server, design system, shell, and Module 1 (PR Workbench) as the reference implementation.

## Read first (in this order)
1. `docs/ENGINEERING.md` — conventions and cross-module contracts. Mandatory.
2. `docs/PRD.md` — requirements. Implement every FR/AC in your sections; cite ids in comments and tests.
3. Reference module: `server/modules/pr/service.ts`, `server/modules/pr/index.ts`, `web/src/pages/pr/*.tsx`, `server/tests/pr.test.ts`.
4. `server/core/schema.ts` (all tables already exist), `server/core/statuses.ts`, `server/seed/base.ts` (demo data and SAP payload
   shapes), `server/seed/ctx.ts`, and the core helpers you use (`sap.ts`, `approvals.ts`, `notify.ts`, `config.ts`, `files.ts`,
   `auth.ts`, `permissions.ts`, `http.ts`, `india.ts`), plus `web/src/components/*`, `web/src/lib/*`, `web/src/nav.ts`.

## File ownership
Create/edit only the files your task lists under "You own". Do not edit core files, other modules, `schema.ts`,
`permissions.ts`, `nav.ts`, `App.tsx`, shared components or styles. If you need a change there, work around it inside your files
and list the request in your final report. Other engineers are editing other modules at the same time: if a typecheck or test
fails because of somebody else's file, do not touch it — re-run later. You may read any file. You may import exported
functions from another module's `service.ts` if it exists; if it does not exist yet, query the tables directly.

## Quality bar (the client was explicit)
- Build the product, not a mockup. Every navigation item, button, form, filter, search, table action, approval, upload, status
  transition and drill-down in your screens must work against the real API with persistent storage. No hard-coded demo arrays
  in the UI, no dead buttons, no "coming soon".
- Simulated externals (SAP, OCR, e-mail/SMS, AI) are labelled with `SimBadge` / `.sim-panel`; never claim an external success.
- Unresolved business rules are configuration with a decision id (`registerConfig`, `DecisionTag`), not invented constants.
- Server-side permission checks on every route; vendor isolation on every vendor-facing query; audit every state change with
  before/after and reason; notifications per PRD Sec 14 with working links.
- Validation with messages that say how to fix the problem. Loading, empty, error and success states on every screen.
- Responsive: usable at 390 px (DataTable `mobile` cards, stacked forms, camera upload where the PRD asks for photos) and polished
  at 1440 px. Follow the design rules in ENGINEERING.md; match the reference module's look exactly.

## Running things in parallel without stepping on each other
Use your own ports and data directory (given in your task). Start long-running servers as background tasks, e.g. PowerShell:
`$env:PORT='41xx'; $env:S2P_DATA_DIR='data/agent-<name>'; npx tsx server/index.ts` and
`$env:S2P_API_PORT='41xx'; npx vite --config web/vite.config.ts --port 51xx --strictPort`.
The API does not hot-reload: restart your API after server changes (stop the background task, start again). Delete your data dir
to re-seed after changing seed code. Never use ports 4000/5173 and never delete `data/s2p.db`.
Run vitest from PowerShell (`npx vitest run server/tests/<file>.test.ts`) — Git Bash breaks vitest's drive-letter check.
In Git Bash set `MSYS_NO_PATHCONV=1` before passing URL paths to scripts.
Screenshots: `$env:SHOT_BASE='http://localhost:51xx'; python scripts/shot.py <email> <outdir> /path1,/path2 [width]` signs in as a seeded
persona (password Equipcare@2026; vendor OTP handled) and saves full-page PNGs. Seeded e-mails: `<local>@equipcare.test` for
internal users (anjali.verma ADM, priya.nair / rahul.deshmukh / farhan.qureshi REQ, amit.kulkarni / sneha.patil BUY, vikram.joshi APR+BUY,
meera.iyer / kiran.shah FIN, suresh.pawar / lakshmi.reddy STO, neha.gupta SAP, rajesh.menon MGT); vendors manoj.kale@hydrotech.test (100101),
divya.raman@shakti-ucg.test (100102), sanjay@westernlube.test (100104), pooja.malhotra@precisionfilt.test (100105),
imran@deccanreman.test (100106), nitin@krantitools.test (100108), ravi.teja@orionseal.test (onboarding vendor, no SAP code).
Save screenshots under `C:\Users\Admin\AppData\Local\Temp\claude\d--Downloads-S2P\baf77290-e20f-47c2-96a0-7d4b9ec39bd2\scratchpad\shots\<your-module>\`.

## Definition of done
1. `npx tsc -p server/tsconfig.json` and `npx tsc -p web/tsconfig.json` report no errors in your files.
2. `server/tests/<module>.test.ts` covers your PRD acceptance criteria (use `server/tests/helpers.ts`); all pass.
3. Your seed creates the demo scenarios in your task on a fresh database without errors (check your API log on boot).
4. You ran your API + web, screenshotted every one of your screens at 1440 px and the phone-priority ones at 390 px as the right
   personas, looked at each image, and fixed what looked wrong (overflow, empty states, wrapping, alignment). Drive the main flow
   end to end through the UI at least once with a short Playwright script (fill forms, click buttons, confirm the toast/state).
5. You stopped your background servers.

## Final report (keep it short — no code)
Files created; API endpoints; routes/screens; seed scenarios; tests (count, result); requests to the lead (permissions, schema,
nav, shared component changes) with the reason; known gaps or deviations from the PRD.
