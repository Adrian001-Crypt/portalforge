# Security model

Third-party libraries are used as published (viem, @polkadot/api, hono, zod, undici, React, forge-std). **Using a library is not an audit.** The contracts in this repository have not been audited.

## Trust boundaries

| Input | Treated as | Controls |
|---|---|---|
| Browser requests | untrusted | session cookie HttpOnly + SameSite=Lax; writes need `x-csrf-token` (per session) **and** an allowed `Origin`; zod validation; 512 KiB body limit; rate limits |
| API keys | scoped credential | stored as SHA-256; project-bound; scopes `read`, `events:read`, `workflow:run`, `evidence:write`; never owner rights; revocable; shown once |
| Contract events, ABIs, metadata | untrusted data | ABI item types/names whitelisted, ≤400 items; decoding failures isolated per log; values rendered as text (React escaping), never as HTML or links to arbitrary origins |
| Workflow definitions | untrusted program | closed set of step types; templates are path lookups only (no code); `__proto__`/`constructor` rejected; references must be upstream; no shell, no dynamic imports, no raw URLs |
| Webhook targets | untrusted network | connectors only; http(s), no credentials, standard ports; DNS resolved per request and **every** address must be public; the socket is pinned to the validated addresses (closes DNS rebinding); redirects refused; 256 KiB response cap; private hosts only when the deployment sets `PF_ALLOW_PRIVATE_CONNECTORS=1` (local demo) |
| Webhook responses | untrusted data | must be a JSON object; schema-validated by `validate` steps before use on-chain |
| RPC endpoints | untrusted infra | identity asserted (chainId / genesis) before indexing or writing; read failure ≠ empty; registered monitoring endpoints must be public unless `PF_ALLOW_PRIVATE_RPC=1` |
| Model output (optional explain) | untrusted text | receives recorded facts only; no tools; stored as a labelled explanation; cannot change state |

## Authorization

- Application roles (Owner / Developer / Operator / Viewer) — `packages/domain/src/rbac.ts`. These are **not** on-chain permissions; the Contract page shows platform roles and live `owner()/executor()/isWriter()` side by side.
- Non-members of private projects receive **404**, so project existence does not leak.
- Public read-only projects: anonymous read only; audit log hidden; every write refused (401/403). Fault-injection endpoints exist only on the demo service, behind `DEMO_FAULTS=1` and an admin token, bound to 127.0.0.1.
- Tests: `apps/api/test/api.test.ts` (CSRF, Origin, isolation, roles, key scopes, SSRF, body limit, ABI injection, export secrecy, public read-only), `e2e/two-browsers.spec.ts`.

## Chain execution policy

The executor (worker) **cannot**: call unregistered addresses; call functions not on the project allowlist; call payable functions or send value; encode arguments with unknown ABI types; exceed per-function calls/hour or max fee; use another network's key; change its own permissions (policies are written via the API by Developer/Owner only, with audit).
Each write re-checks network identity, simulates, estimates fee and balance (RPC failure aborts), then signs with a dedicated low-privilege key and persists the signed tx before broadcast.

Contracts: no upgrade proxy, no arbitrary-call entry point, no payable/receive/fallback (value transfers revert — tested), no external calls (so no reentrancy surface), two-step ownership, one executor/writer role each. `JobRegistry` validates `result == input²` on-chain and completes each job once; `EvidenceRegistry` allows only the original writer to revoke.

## Keys and secrets

- PortalForge never reads or asks for user mnemonics/private keys. Browser signing goes through the user's wallet.
- `npm run keygen` generates **new** testnet-only deployer/executor keys into `.secrets/` (mode 0600, gitignored). Addresses are printed; keys never are. The worker refuses a key file readable by group/others.
- Logs are structured JSON with key-based redaction (`private|secret|token|password|authorization|cookie|api_key|raw_tx|mnemonic|seed|signature|session`) and truncation of long hex blobs.
- Project export contains configuration only (no sessions, key hashes, intents with signed txs). Tested.
- The browser never receives the database, other projects, or server configuration.

## Indexing integrity

Cursor and events commit atomically; event ids include the block hash; unfinalized window re-checked every tick; reorgs orphan rows and rewind (A→B→A restores the original rows); finalized only after the block hash is re-verified; runtime upgrades re-key decoding per block (`runtime:spec<N>`).

## Known limitations

- Dev sign-in (`PF_DEV_LOGIN=1`) is for local/demo only; a production deployment needs a real identity provider in front of the same session model.
- SQLite single-host store (see architecture.md).
- Rate limiter is in-memory per API process.
- No independent security review has been performed.
