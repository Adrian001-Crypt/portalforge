# Post-funding evidence

All of it is recorded in [testnet-evidence/README.md](testnet-evidence/README.md), generated from the chain by `scripts/collect-testnet-evidence.ts`.

| Item | Status |
|---|---|
| Contract addresses, deploy transactions, manifest verification | Done |
| Executor funding | Done |
| Full job on V3, twice: all transactions, execution ids, evidence, CLI verification | Done |
| Live smoke with `deployment.verify` passing | Done |
| The EVM balance view of a funded account | Confirmed, `docs/network-capabilities.md` §4 |
| Real gas per call | Measured, replaced the estimate |
| Video shots on V3 | Done |
| Fault recovery on V3 | Not run, by choice: local only, to save tokens |
