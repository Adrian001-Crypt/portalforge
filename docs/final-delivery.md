# Final delivery: round 4 (2026-11-04)

## Current state

| Item | State |
|---|---|
| Repository | **Public:** https://github.com/Adrian001-Crypt/portalforge |
| Portaldot V3 testnet | **Deployed:** JobRegistry `0xd5dcf5a7d69354b07f776f8a961348f0a394d746`, EvidenceRegistry `0xf005d9e544a399196473ec167eda85c089d80cff`; two full jobs finalized; evidence in `docs/testnet-evidence/README.md` |
| Project page | **Public:** https://adrian001-crypt.github.io/portalforge/ |
| Read-only demo | **Public:** https://adrian001-crypt.github.io/portalforge/demo/ (static snapshot of the V3 stack) |
| Video | **Public:** https://adrian001-crypt.github.io/portalforge/media/portalforge-demo.mp4 (2:24, V3 footage plus labelled local scenes) |
| Pitch deck | **Public:** https://adrian001-crypt.github.io/portalforge/pitch/portalforge-pitch.pdf |
| Submission | **Submitted on DoraHacks 2026-11-05; status Under Review** |

## How to start

```bash
npm ci && npm run contracts:build
npm run dev                                   # local stack, console http://localhost:5180 (Ctrl+C stops)
PF_MODE=testnet PF_DATA_DIR=data/testnet npm run dev   # the V3 stack; runs the real executor key and worker
npx tsx scripts/public-demo.ts                # live read-only stack on http://127.0.0.1:4400 (dev sign-in off)
```

## Verification this round

**Live V3:** deployment 25/25 ✔ · 2 of 2 jobs ✔ · cross-checks 18/18 ✔ · CLI evidence verified ✔ · smoke 9 pass / 1 n.a.
**Local:** typecheck ✔ · 22 contract tests ✔ · 69 Vitest ✔ · web build ✔ · E2E 7/7 ✔ · deploy recovery and budget 11/11 ✔ · Chrome 8/8 ✔ · webhooks 14/14 ✔.
**Public site:** 38/38 ✔. Details: `docs/test-results.md`.

## Files

| What | Where |
|---|---|
| Demo video | `docs/media/portalforge-demo.mp4` |
| Screenshots | `docs/media/screenshots/*.png` |
| Narration + shot list (EN/中文) | `docs/demo-script.md` |
| Pitch deck PDF / sources | `docs/pitch/portalforge-pitch.pdf`, `docs/pitch/slides/` |
| Submission text and field map | `docs/submission-draft.md` |
| Checklist | `docs/submission-checklist.md` |
| Budget, actual spend, how to repeat | `docs/funding-handoff.md` |
| Testnet evidence | `docs/testnet-evidence/README.md` |
| Test evidence (JSON) | `docs/test-results/`, `docs/probe/` |

## What you need to do

1. **Organizers:** send the template in `docs/hackathon-requirements.md` (eligibility without check-in; multi-track).
2. **Old repository:** still public under your previous account. Make it private or delete it when you decide.
3. **After the deadline:** code freeze applies, so report any serious fix to the organizers and keep a record of it.

## Not claimed

Fault recovery on V3 (local only), a browser wallet on V3, ink!/WASM, EVM↔WASM calls, cross-chain features, performance numbers, users/customers/revenue, exactly-once against arbitrary services, any award or eligibility decision.
