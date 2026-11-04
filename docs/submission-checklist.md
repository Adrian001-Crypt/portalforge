# Submission checklist

Rules re-read on 2026-11-03 from the DoraHacks page: deadline / code freeze **2026-11-06 04:00 UTC** (11-05 22:00 Chicago); ≥ 3 valid commits in the event period; core modules not committed all at once in the last 24 h (window opens 2026-11-05 04:00 UTC); demo video ≤ 3 min, public link; pitch deck as PDF or public link; testnet deployment with contract address and tx hash.

Legend: ☑ done · ☐ open · (you) = only you can do it.

## Eligibility and registration
- ☐ (you) Ask organizers: judging eligibility without the Oct 24 check-in; multi-track selection — template in `docs/hackathon-requirements.md`.
- ☐ (you) Confirm you are registered for the hackathon on DoraHacks (signed in, accept the platform terms yourself).
- ☐ (you) Receive testnet tPOT on your native SS58 address via the official channel.

## Code and repository
- ☑ Independent git repo with real commits starting 2026-11-03, no empty commits. The 20 commits from 2026-11-03 were rewritten to use the current account's GitHub noreply identity when the repo moved to this account, with original dates and messages kept; two doc lines naming a personal email were also changed. Hashes changed; nothing was backdated.
- ☑ Pre-publish scan of all history: no keys, `.env`, `.secrets`, databases or tokens; `.claude/` local config untracked; no absolute local paths in docs at HEAD (older versions of `docs/handoff.md` and `.claude/launch.json` in history contain a local home path).
- ☑ LICENSE (Apache-2.0), THIRD_PARTY.md, AI-assistance disclosure in README.
- ☑ README verified from a fresh clone (install → build → verify → dev).
- ☑ Commit author and committer: GitHub noreply identity on every commit.
- ☑ Public GitHub repo: https://github.com/Adrian001-Crypt/portalforge → **Public** (anonymous clone verified).

## Testnet evidence (after funding)
- ☐ Deploy (`minimal`), verify, fund executor — commands and success criteria in `docs/funding-handoff.md`.
- ☐ One full job on V3: requestJob → workflow → completeJob → evidence register → `pf evidence verify`.
- ☐ Paste real addresses and tx hashes into `docs/submission-draft.md`, `docs/final-delivery.md`, README status line and deck slide 7.
- ☐ Finish before 2026-11-05 04:00 UTC if possible (deployment evidence is not a core-module code change, but earlier is safer).

## Media
- ☑ Local demo video recorded: `docs/media/portalforge-demo.mp4` (2:08, labelled local, synthetic narration).
- ☐ Optional: re-record with testnet shots (list in `docs/demo-script.md`) and/or your own voice.
- ☐ (you) Upload the video (unlisted YouTube / Loom / Drive with “anyone with the link”) → **Uploaded**; check it plays logged-out.
- ☑ Pitch deck PDF: `docs/pitch/portalforge-pitch.pdf` (public through the repo). ☑ repo link on slides 1 and 10. ☐ (you) team name on slide 1.
- ☑ Screenshots: `docs/media/screenshots/` (16).

## Public demo (optional but useful for judges)
- ☑ Public read-only mode verified locally (17/17 visitor checks).
- ☐ (you) Start it where judges can reach it: `npx tsx scripts/public-demo.ts --tunnel` (temporary URL, lives while the command runs) or a host of your choice → **Public**.

## DoraHacks form (you, signed in)
- ☐ Project name, one-liner, long description, track, team, repo URL, video URL, deck link/PDF, contract addresses + tx hashes, demo URL — all values in `docs/submission-draft.md`.
- ☐ Submit → check the build page shows it as submitted → **Submitted**. Only then call it submitted.
