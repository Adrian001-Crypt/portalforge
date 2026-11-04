import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createWalletClient, defineChain, http, publicActions, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * The browser-wallet deployment path on a local chain, with a wallet that really signs: the injected EIP-1193
 * provider hands eth_sendTransaction to a viem account (Anvil dev key #3, public) which signs and broadcasts a
 * raw transaction, as an extension wallet would. It is not MetaMask and it is not Portaldot.
 * Modes: ok · reject (4001) · lost (broadcast, then the wallet errors, so the hash never reaches the page).
 */
const RPC = process.env.PF_E2E_RPC ?? 'http://127.0.0.1:8547';
const KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex;
const account = privateKeyToAccount(KEY);
const EXECUTOR = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
const EMPTY = '0x00000000000000000000000000000000000f00d1'; // never funded
const chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const client = createWalletClient({ account, chain, transport: http(RPC) }).extend(publicActions);
const nonce = () => client.getTransactionCount({ address: account.address, blockTag: 'pending' });

async function withWallet(ctx: BrowserContext, addr: string = account.address) {
  await ctx.exposeFunction('__pfSignAndSend', async (tx: { data: Hex; to?: Hex }) => client.sendTransaction({ data: tx.data, ...(tx.to ? { to: tx.to } : {}) } as any));
  await ctx.addInitScript({ content: `(() => {
    const rpc = ${JSON.stringify(RPC)};
    const call = async (method, params = []) => { const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code }); return j.result; };
    window.__pfMode = 'ok';
    window.ethereum = { on() {}, removeListener() {}, request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [${JSON.stringify(addr.toLowerCase())}];
      if (method === 'eth_chainId') return window.__pfChain ?? call(method);
      if (method === 'eth_sendTransaction') {
        if (window.__pfMode === 'reject') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        const hash = await window.__pfSignAndSend(params[0]);
        if (window.__pfMode === 'lost') throw Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 });
        return hash;
      }
      return call(method, params);
    } };
  })();` });
}

async function open(page: Page) {
  await page.goto('/');
  await page.getByLabel('Handle').fill('demo-owner');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('banner').getByText('Signed in as')).toBeVisible();
  await page.goto('/p/local-demo/deployments');
  await expect(page.getByRole('button', { name: 'Use wallet' })).toBeVisible();
}

async function plan(page: Page, template = 'JobRegistry') {
  await page.getByLabel('Template').selectOption(template);
  await page.getByRole('button', { name: 'Use wallet' }).click();
  await expect(page.getByLabel(/Owner \/ deployer/)).toHaveValue(new RegExp(`^0x`, 'i'));
  await page.getByLabel(/PortalForge executor/).fill(EXECUTOR);
  await page.getByRole('button', { name: /^Plan/ }).click();
  await expect(page.getByText('Your balance')).toBeVisible({ timeout: 30_000 });
}

const get = async (page: Page, path: string) => (await page.request.get(`/api/v1${path}`)).json();
const records = async (page: Page) => (await get(page, '/projects/local-demo/deployments')).items;
const intents = async (page: Page) => (await get(page, '/projects/local-demo/wallet-intents')).items;

test('plan, sign, confirm: the deployed contract is verified, recorded and registered', async ({ browser }) => {
  const ctx = await browser.newContext(); await withWallet(ctx);
  const page = await ctx.newPage(); await open(page);
  const before = (await records(page)).length;
  await plan(page);
  await expect(page.getByText('runtime matches artifact')).toBeVisible();
  await page.getByRole('button', { name: 'Sign & deploy with wallet' }).click();
  await expect(page.getByText(/Manifest verified/)).toBeVisible({ timeout: 60_000 });

  const rec = await records(page);
  expect(rec.length).toBe(before + 1);
  const dep = rec[0];
  expect(dep.status).toBe('verified');
  expect(dep.manifest.source.commit).toMatch(/^[0-9a-f]{40}$/);
  const c = dep.manifest.contracts[0];
  expect(c.name).toBe('JobRegistry');
  expect(c.constructorArgs.map((a: string) => a.toLowerCase())).toEqual([account.address.toLowerCase(), EXECUTOR.toLowerCase()]);
  expect(await client.getCode({ address: c.address })).not.toBe('0x');
  expect(dep.verification.checks.every((x: any) => x.status !== 'fail')).toBe(true);

  const contracts = (await get(page, '/projects/local-demo/contracts')).items;
  expect(contracts.some((x: any) => x.address === c.address.toLowerCase())).toBe(true);
  const w = (await intents(page))[0];
  expect(w).toMatchObject({ kind: 'deploy', state: 'confirmed', deployment_id: dep.id, function_name: 'JobRegistry' });

  // Registering again is a no-op: same record, no duplicate contract.
  const session = await get(page, '/auth/me');
  const again = await page.request.post(`/api/v1/wallet-intents/${w.id}/manifest`, { headers: { 'x-csrf-token': session.csrfToken, origin: new URL(page.url()).origin }, data: {} });
  expect(again.ok(), await again.text()).toBe(true);
  expect((await again.json()).deploymentId).toBe(dep.id);
  expect((await records(page)).length).toBe(before + 1);

  await page.goto(`/p/local-demo/deployments/${dep.id}`);
  await page.getByRole('button', { name: 'Re-verify on chain' }).click();
  await expect(page.getByText('Re-verified against chain')).toBeVisible({ timeout: 30_000 });
  await ctx.close();
});

test('rejecting in the wallet sends nothing and records nothing', async ({ browser }) => {
  const ctx = await browser.newContext(); await withWallet(ctx);
  const page = await ctx.newPage(); await open(page);
  const n0 = await nonce(); const before = (await records(page)).length;
  await plan(page);
  await page.evaluate(() => { (window as any).__pfMode = 'reject'; });
  await page.getByRole('button', { name: 'Sign & deploy with wallet' }).click();
  await expect(page.getByText('You rejected the request in the wallet.')).toBeVisible();
  expect((await intents(page))[0].state).toBe('rejected');
  expect(await nonce()).toBe(n0);
  expect((await records(page)).length).toBe(before);
  await ctx.close();
});

test('wallet on the wrong chain: refused before any intent or signature', async ({ browser }) => {
  const ctx = await browser.newContext(); await withWallet(ctx);
  const page = await ctx.newPage(); await open(page);
  const n0 = await nonce();
  await plan(page);
  const count = (await intents(page)).length;
  await page.evaluate(() => { (window as any).__pfChain = '0x190f1ca9'; });
  await page.getByRole('button', { name: 'Sign & deploy with wallet' }).click();
  await expect(page.getByText(/Wallet is on chain 420420777/)).toBeVisible();
  expect((await intents(page)).length).toBe(count);
  expect(await nonce()).toBe(n0);
  await ctx.close();
});

test('an unfunded account gets a blocker and no deploy button', async ({ browser }) => {
  const ctx = await browser.newContext(); await withWallet(ctx, EMPTY);
  const page = await ctx.newPage(); await open(page);
  const count = (await intents(page)).length;
  await plan(page);
  await expect(page.getByText(/deployer balance 0 < estimated max fee/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign & deploy with wallet' })).toBeDisabled();
  expect((await intents(page)).length).toBe(count);
  await ctx.close();
});

test('wallet loses the hash after broadcast: reload, reconcile, finish registration once', async ({ browser }) => {
  const ctx = await browser.newContext(); await withWallet(ctx);
  const page = await ctx.newPage(); await open(page);
  const before = (await records(page)).length; const n0 = await nonce();
  await plan(page, 'EvidenceRegistry');
  await page.evaluate(() => { (window as any).__pfMode = 'lost'; });
  await page.getByRole('button', { name: 'Sign & deploy with wallet' }).click();
  await expect(page.getByText(/may still have been sent/)).toBeVisible({ timeout: 30_000 });
  expect(await nonce()).toBe(n0 + 1);                 // it really went out
  const lost = (await intents(page))[0];
  expect(lost.state).toBe('unknown');
  expect(lost.tx_hash).toBeNull();

  await page.reload();                                // the plan in memory is gone; recovery must not need it
  const row = page.locator('tr', { hasText: 'deploy EvidenceRegistry' }).first();
  // The block may not be mined yet: Reconcile says so and can be pressed again.
  await expect(async () => {
    const reconcile = row.getByRole('button', { name: 'Reconcile' });
    if (await reconcile.isVisible()) await reconcile.click();
    await expect(row.getByRole('button', { name: 'Register deployment' })).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 30_000 });
  const found = (await intents(page))[0];
  expect(found.state).toBe('confirmed');
  expect(found.tx_hash).toMatch(/^0x/);

  await row.getByRole('button', { name: 'Register deployment' }).click();
  await expect(page.getByText(/Deployment registered/)).toBeVisible({ timeout: 30_000 });
  const rec = await records(page);
  expect(rec.length).toBe(before + 1);
  expect(rec[0].status).toBe('verified');
  expect(rec[0].manifest.contracts[0].name).toBe('EvidenceRegistry');
  await expect(row.getByRole('button', { name: 'Register deployment' })).toHaveCount(0);
  await ctx.close();
});
