import { useApi, Async, Card, PageHead } from '../ui';

const CLI = [
  ['pf doctor', 'toolchain, RPC reachability, secrets hygiene'],
  ['pf network inspect --network portaldot-v3-testnet', 'live capability probe (read-only)'],
  ['pf project init --api http://127.0.0.1:4300 --project local-demo', 'write portalforge.config.json'],
  ['pf deploy plan --profile minimal', 'simulate creates, exact storage deposit, balance check'],
  ['pf deployment verify deployments/portaldot-v3-testnet.json', 're-read every manifest claim from chain'],
  ['pf events tail --contract jobs --follow', 'stream indexed events (API key)'],
  ['pf events tail --address 0x… --follow', 'stream raw logs from RPC (no API)'],
  ['pf workflow validate examples/workflows/job-square.json', 'DAG + reference validation'],
  ['pf workflow simulate examples/workflows/job-square.json --trigger \'{"args":{"jobId":"1","input":"7"}}\'', 'dry-run, no side effects'],
  ['pf execution inspect 0x…', 'steps, attempts, intents, evidence'],
  ['pf evidence verify <evidenceId>', 'verify on-chain independently of the server'],
];

export function Developers() {
  const spec = useApi<any>('/openapi.json');
  return (
    <div className="content">
      <PageHead title="Developer API / CLI" sub="Everything in the console is available over HTTP, the TypeScript SDK and the pf CLI." />
      <div className="grid g2">
        <Card title="CLI (pf)"><table className="t"><tbody>{CLI.map(([c, d]) => <tr key={c}><td className="mono small">{c}</td><td className="small muted">{d}</td></tr>)}</tbody></table>
          <div className="small faint" style={{ marginTop: 8 }}>Flags: --json · --network · --rpc · --api · --project · --timeout. Exit codes: 0 ok, 1 failed check, 2 usage, 3 not configured, 4 network error. API keys come from PF_API_KEY and are never printed.</div></Card>
        <Card title="SDK (@portalforge/sdk)"><pre className="json">{`import { PortalForgeClient, probeNetwork, verifyManifest, verifyEvidence } from '@portalforge/sdk';
import { PORTALDOT_V3_TESTNET } from '@portalforge/domain';

const report = await probeNetwork(PORTALDOT_V3_TESTNET);      // live capabilities
const pf = new PortalForgeClient({ baseUrl, apiKey: process.env.PF_API_KEY });
for await (const e of pf.allEvents('local-demo', { event: 'JobRequested' })) console.log(e.args);
const v = await verifyManifest(manifest, PORTALDOT_V3_TESTNET);  // re-reads chain`}</pre></Card>
      </div>
      <div style={{ height: 14 }} />
      <Card title="HTTP API (OpenAPI 3.1)" right={<a className="btn sm" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">openapi.json</a>} flush>
        <Async q={spec}>{(s) => <div className="table-wrap"><table className="t"><thead><tr><th>Method</th><th>Path</th><th>Access</th><th>Summary</th></tr></thead><tbody>
          {Object.entries(s.paths).flatMap(([path, ops]: any) => Object.entries(ops).map(([m, o]: any) => <tr key={m + path}><td><span className="tag plain accent">{m.toUpperCase()}</span></td><td className="mono small">{path}</td><td className="small">{o['x-portalforge-access']}</td><td className="small">{o.summary}</td></tr>))}
        </tbody></table></div>}</Async>
      </Card>
      <div style={{ height: 14 }} />
      <Card title="Auth model"><ul className="small" style={{ margin: 0, paddingLeft: 18 }}><li>Console: HttpOnly session cookie; every write needs the session CSRF token and a same-origin Origin header.</li><li>Automation: project-scoped API keys with explicit scopes (read, events:read, workflow:run, evidence:write). A key never has owner rights.</li><li>Public demo projects are readable anonymously and never writable without membership. Non-members of private projects get 404.</li></ul></Card>
    </div>
  );
}
