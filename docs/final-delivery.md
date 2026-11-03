# Final delivery — round 2 (2026-11-03)

## Current state

| Item | State |
|---|---|
| Repository | Local, independent git repo at the project root; **not yet public** (no GitHub login on the build machine) |
| Product | Runs locally (`npm run dev`); public read-only mode ready (`scripts/public-demo.ts`) |
| Portaldot testnet | Read-only integration verified live; **contracts not deployed** (deployer unfunded) |
| Video | `docs/media/portalforge-demo.mp4`, 2:08, local footage — **prepared, not uploaded** |
| Pitch deck | `docs/pitch/portalforge-pitch.pdf` (10 pages) — **prepared**; private Claude artifact copy exists but is not a public link |
| Submission | Draft and field mapping in `docs/submission-draft.md` — **not submitted** |

## How to start

```bash
npm ci && npm run contracts:build
npm run dev                                   # local stack, console http://localhost:5180 (Ctrl+C stops)
npx tsx scripts/public-demo.ts                # public read-only stack on http://127.0.0.1:4400 (dev sign-in off)
```

## Verification this round

typecheck ✔ · 21 contract tests ✔ · 59 Vitest ✔ · web build ✔ · fresh clone ✔ · E2E 7/7 ✔ · deploy resume 7/7 ✔ · Chrome 3/3 ✔ · public visitor 17/17 ✔ · live V3 smoke 8 pass / 2 n.a. — details `docs/test-results.md`.

## Files

| What | Where |
|---|---|
| Demo video | `docs/media/portalforge-demo.mp4` |
| Screenshots | `docs/media/screenshots/*.png` |
| Narration + shot list (EN/中文) | `docs/demo-script.md` |
| Pitch deck PDF / sources | `docs/pitch/portalforge-pitch.pdf`, `docs/pitch/slides/` |
| Submission text and field map | `docs/submission-draft.md` |
| Checklist | `docs/submission-checklist.md` |
| Funding budget + post-funding runbook | `docs/funding-handoff.md` |
| Test evidence (JSON) | `docs/test-results/`, `docs/probe/` |

## What you need to do

1. **Publish the repository** (pick one):
   - Web + git (no new tools): create an empty **public** repo named `portalforge` at github.com/new (no README/license). Then in the project directory:
     ```bash
     git remote add origin https://github.com/<your-user>/portalforge.git
     git push -u origin main
     ```
     The push asks you to sign in. If it asks for a password, use a fine-grained token scoped to that one repo with "Contents: read and write".
   - Before pushing, decide whether the commit email your personal email may be public. If not, tell me and I'll explain the trade-off (changing it rewrites commit hashes, though not the dates).
2. **Organizer questions** — send the template in `docs/hackathon-requirements.md` (eligibility without check-in; multi-track).
3. **Testnet tPOT** — request it through the official channel. Then send about **500 tPOT** to `5Fxg3MEsonAtt2giPzUjQMAMmBu3UDVGb5NjnQkZK4oczF1t` and tell me it's done.
4. **Video** — upload `docs/media/portalforge-demo.mp4` as unlisted. Re-record with testnet shots after deployment if you want (`docs/demo-script.md`).
5. **Public demo** (optional) — run `npx tsx scripts/public-demo.ts --tunnel` on a machine that stays on, and share the printed `https://…trycloudflare.com` URL. It's temporary: the URL dies when the command stops. I could not start the tunnel from this session.
6. **Team info** — send me your name/handle and a one-line bio. I'll fill the deck (slides 1 and 10) and the submission draft.
7. **DoraHacks form** — sign in, fill it from `docs/submission-draft.md`, submit, and confirm the build page shows it.

## After tPOT arrives (in order)

1. `npx pf deploy plan --profile minimal` → no BLOCKER
2. `npm run deploy:apply -- portaldot-v3-testnet --profile minimal --confirm --fund-executor 60`
3. `npm run deploy:verify -- portaldot-v3-testnet` and `npx pf deployment verify deployments/portaldot-v3-testnet.json`
4. `PF_MODE=testnet npm run dev`
5. `npx tsx scripts/request-job.ts portaldot-v3-testnet 12 --confirm` → execution succeeds (≈1–2 min)
6. `npx pf execution inspect <id> --api http://127.0.0.1:4300` and `npx pf evidence verify <evidenceId> --api http://127.0.0.1:4300`
7. `npm run smoke:testnet` → `deployment.verify` passes
8. Record addresses and tx hashes; update README, deck slide 7, submission draft; optionally re-record the video

Success criteria for each step are in `docs/funding-handoff.md`.

## Not claimed

Testnet deployment (until done), ink!/WASM, EVM↔WASM calls, cross-chain features, performance numbers, users/customers/revenue, exactly-once against arbitrary services, any submission or registration status.
