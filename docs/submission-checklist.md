# Submission checklist

Rules re-read on 2026-11-03 from the DoraHacks page: deadline / code freeze **2026-11-06 04:00 UTC** (11-05 22:00 Chicago); ≥ 3 valid commits in the event period; core modules not committed all at once in the last 24 h (window opens 2026-11-05 04:00 UTC); demo video ≤ 3 min, public link; pitch deck as PDF or public link; testnet deployment with contract address and tx hash.

Legend: ☑ done · ☐ open · (you) = only you can do it.

## Eligibility and registration
- ☐ (you) Ask organizers: judging eligibility without the Oct 24 check-in; multi-track selection — template in `docs/hackathon-requirements.md`.
- ☐ (you) Confirm you are registered for the hackathon on DoraHacks (signed in, accept the platform terms yourself).
- ☐ (you) Receive 450 tPOT on the deployer `5Fxg3MEs…czF1t` via the official channel (requested; budget in `docs/funding-handoff.md`).

## Code and repository
- ☑ Independent git repo with real commits starting 2026-11-03, no empty commits. The 20 commits from 2026-11-03 were rewritten to use the current account's GitHub noreply identity when the repo moved to this account, with original dates and messages kept; two doc lines naming a personal email were also changed. Hashes changed; nothing was backdated.
- ☑ Pre-publish scan of all history: no keys, `.env`, `.secrets`, databases or tokens; `.claude/` local config untracked; no absolute local paths in docs at HEAD (older versions of `docs/handoff.md` and `.claude/launch.json` in history contain a local home path).
- ☑ LICENSE (Apache-2.0), THIRD_PARTY.md, AI-assistance disclosure in README.
- ☑ README verified from a fresh clone (install → build → verify → dev).
- ☑ Commit author and committer: GitHub noreply identity on every commit.
- ☑ Public GitHub repo: https://github.com/Adrian001-Crypt/portalforge → **Public** (anonymous clone verified).

## Testnet evidence (after funding)
- ☐ Deploy (`minimal`), verify, forward 35 tPOT to the executor: commands and success criteria in `docs/funding-handoff.md`.
- ☐ Two jobs on V3, one normal and one with a dropped response: requestJob → workflow → completeJob → evidence register → `pf evidence verify`.
- ☐ Fill `docs/post-funding-evidence.md` with real addresses and tx hashes, and update the files it lists.
- ☐ Finish before 2026-11-05 04:00 UTC if possible (deployment evidence is not a core-module code change, but earlier is safer).

## Media
- ☑ Local demo video recorded: `docs/media/portalforge-demo.mp4` (2:18, labelled local, synthetic narration).
- ☐ After funding: add the testnet shots listed in `docs/post-funding-evidence.md`. Your own voice is optional.
- ☑ Video public without login: https://adrian001-crypt.github.io/portalforge/media/portalforge-demo.mp4, plays in the browser. A YouTube copy is optional.
- ☑ Pitch deck PDF: `docs/pitch/portalforge-pitch.pdf`, with the repo link on slides 1 and 10 and no placeholders.
- ☑ Screenshots: `docs/media/screenshots/` (16).

## Public demo (optional but useful for judges)
- ☑ Public read-only mode verified locally (17/17 visitor checks).
- ☑ Static read-only demo public without login: https://adrian001-crypt.github.io/portalforge/demo/ (30/30 anonymous checks on the live URL, desktop and phone).
- ☐ Optional: a live stack, `npx tsx scripts/public-demo.ts --tunnel`, on a machine that stays on. Its URL lasts only while it runs.

## DoraHacks form (you, signed in)
- ☐ Project name, one-liner, long description, track, team, repo URL, video URL, deck link/PDF, contract addresses + tx hashes, demo URL — all values in `docs/submission-draft.md`.
- ☐ Submit → check the build page shows it as submitted → **Submitted**. Only then call it submitted.
