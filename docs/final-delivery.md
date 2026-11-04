# Final delivery: round 3 (2026-11-04)

## Current state

| Item | State |
|---|---|
| Repository | **Public:** https://github.com/Adrian001-Crypt/portalforge |
| Project page | **Public:** https://adrian001-crypt.github.io/portalforge/ |
| Read-only demo | **Public:** https://adrian001-crypt.github.io/portalforge/demo/ (static snapshot of local Anvil data, labelled) |
| Video | **Public:** https://adrian001-crypt.github.io/portalforge/media/portalforge-demo.mp4 (2:18, local footage, labelled) |
| Pitch deck | **Public:** https://adrian001-crypt.github.io/portalforge/pitch/portalforge-pitch.pdf |
| Portaldot testnet | Read-only integration verified live; **contracts not deployed** (no tokens yet) |
| Submission | Draft and field mapping in `docs/submission-draft.md`: **not submitted** |

## How to start

```bash
npm ci && npm run contracts:build
npm run dev                                   # local stack, console http://localhost:5180 (Ctrl+C stops)
npx tsx scripts/public-demo.ts                # live read-only stack on http://127.0.0.1:4400 (dev sign-in off)
```

## Verification this round

typecheck ✔ · 22 contract tests ✔ · 66 Vitest ✔ · web build ✔ · E2E 7/7 ✔ · deploy recovery and budget 11/11 ✔ · Chrome 8/8 ✔ · webhooks 14/14 ✔ · public visitor 17/17 ✔ · public site 30/30 ✔ · live V3 smoke 8 pass / 2 n.a. Details: `docs/test-results.md`.

## Files

| What | Where |
|---|---|
| Demo video | `docs/media/portalforge-demo.mp4` |
| Screenshots | `docs/media/screenshots/*.png` |
| Narration + shot list (EN/中文) | `docs/demo-script.md` |
| Pitch deck PDF / sources | `docs/pitch/portalforge-pitch.pdf`, `docs/pitch/slides/` |
| Submission text and field map | `docs/submission-draft.md` |
| Checklist | `docs/submission-checklist.md` |
| Budget + post-funding runbook | `docs/funding-handoff.md` |
| What to record after funding | `docs/post-funding-evidence.md` |
| Test evidence (JSON) | `docs/test-results/`, `docs/probe/` |

## What you need to do

1. **Organizers:** send the template in `docs/hackathon-requirements.md` (eligibility without check-in; multi-track). Testnet tokens are already requested.
2. **Tokens:** have the 450 tPOT sent to `5Fxg3MEsonAtt2giPzUjQMAMmBu3UDVGb5NjnQkZK4oczF1t` and tell me. Nothing goes to the executor by hand.
3. **Team info:** the materials name only the GitHub account `Adrian001-Crypt`. If the form needs a display name, role or bio, fill them in or send them to me.
4. **Old repository:** still public under your previous account. Make it private or delete it when you decide.
5. **DoraHacks form:** sign in, fill it from `docs/submission-draft.md`, submit, and confirm the build page shows it.

## After tPOT arrives (in order)

1. `npx pf deploy plan --profile minimal --fund-executor 35 --jobs 3` → no BLOCKER
2. `npm run deploy:apply -- portaldot-v3-testnet --profile minimal --confirm --fund-executor 35 --jobs 3`
3. `npm run deploy:verify -- portaldot-v3-testnet` and `npx pf deployment verify deployments/portaldot-v3-testnet.json`
4. `PF_MODE=testnet npm run dev`
5. `npx tsx scripts/request-job.ts portaldot-v3-testnet 12 --confirm` → execution succeeds (≈1–2 min)
6. `npx pf execution inspect <id> --api http://127.0.0.1:4300` and `npx pf evidence verify <evidenceId> --api http://127.0.0.1:4300`
7. The recovery job (input 9) with a dropped response, steps in `docs/funding-handoff.md`
8. `npm run smoke:testnet` → `deployment.verify` passes
9. Fill `docs/post-funding-evidence.md` and update the files it lists; re-record the testnet shots

Success criteria for each step are in `docs/funding-handoff.md`.

## Not claimed

Testnet deployment (until done), ink!/WASM, EVM↔WASM calls, cross-chain features, performance numbers, users/customers/revenue, exactly-once against arbitrary services, any submission or registration status.
