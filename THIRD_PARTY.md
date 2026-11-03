# Third-party components

PortalForge's own code was written for this project (Oct 14 – Nov 6, 2026 Hacker House period; development started 2026-11-03). Dependencies are used unmodified via npm / forge:

| Component | License | Use |
|---|---|---|
| forge-std v1.9.7 (vendored in contracts/evm/lib) | MIT / Apache-2.0 | Solidity tests |
| viem | MIT | EVM encoding, signing, clients |
| @polkadot/api, util, util-crypto, keyring | Apache-2.0 | native RPC, metadata decoding, SS58 |
| hono, @hono/node-server | MIT | API server |
| zod | MIT | schema validation |
| undici | MIT | pinned-DNS outbound HTTP |
| react, react-dom, react-router-dom | MIT | console |
| vite, @vitejs/plugin-react | MIT | console build |
| vitest, @playwright/test, tsx, typescript | MIT / Apache-2.0 | tests and tooling |
| Foundry (forge/anvil/cast) | MIT / Apache-2.0 | build, test, local chain (not redistributed) |

No code was copied from other projects in this workspace. Development was assisted by Claude Code (Anthropic).
