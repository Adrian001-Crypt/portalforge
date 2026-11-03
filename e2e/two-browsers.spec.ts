import { test, expect, type BrowserContext, type Page } from '@playwright/test';

/**
 * Two independent browser sessions (separate cookies) operate the same project concurrently.
 * A minimal EIP-1193 provider is injected that forwards to the local Anvil node, whose dev
 * accounts are unlocked; `__pfSendDelay` holds the "wallet popup" open to create the race.
 */
const RPC = process.env.PF_E2E_RPC ?? 'http://127.0.0.1:8547';
const ACCOUNT = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'; // Anvil dev account #2 (public test key)

async function wallet(ctx: BrowserContext, delayMs: number) {
  await ctx.addInitScript(({ rpc, account, delay }) => {
    const call = async (method: string, params: unknown[] = []) => {
      const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json(); if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code }); return j.result;
    };
    (window as any).__pfSendDelay = delay;
    (window as any).ethereum = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
        if (method === 'eth_sendTransaction') { await new Promise((r) => setTimeout(r, (window as any).__pfSendDelay)); return call(method, params); }
        return call(method, params);
      },
      on() {}, removeListener() {},
    };
  }, { rpc: RPC, account: ACCOUNT, delay: delayMs });
}

async function signIn(page: Page, handle: string) {
  await page.goto('/');
  await page.getByLabel('Handle').fill(handle);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('banner').getByText('Signed in as')).toBeVisible();
}

async function openRequestJob(page: Page) {
  await page.goto('/p/local-demo/contracts');
  await page.getByRole('cell', { name: /^jobs/ }).first().click();
  await expect(page.getByRole('heading', { name: 'jobs' })).toBeVisible();
  const form = page.locator('form', { hasText: 'requestJob' });
  return form;
}

test('two browsers: one open signing request per account, both jobs execute exactly once', async ({ browser }) => {
  const ctxA = await browser.newContext(); const ctxB = await browser.newContext();
  await wallet(ctxA, 5000); await wallet(ctxB, 0);
  const a = await ctxA.newPage(); const b = await ctxB.newPage();
  await signIn(a, 'demo-owner'); await signIn(b, 'demo-owner');
  const fa = await openRequestJob(a); const fb = await openRequestJob(b);
  const inA = String(3000 + Math.floor(Math.random() * 1000)); const inB = String(5000 + Math.floor(Math.random() * 1000));
  await fa.getByLabel('input').fill(inA); await fb.getByLabel('input').fill(inB);

  await fa.getByRole('button', { name: 'Sign & send' }).click();
  await expect(fa.getByText('signing')).toBeVisible();           // A's wallet "popup" is open
  await fb.getByRole('button', { name: 'Sign & send' }).click();  // B races with the same account
  await expect(fb.getByText(/another signature request .* is still open/)).toBeVisible();

  await expect(fa.getByText('confirmed')).toBeVisible({ timeout: 60_000 });
  await fb.getByRole('button', { name: 'Sign & send' }).click();  // retry after A finished
  await expect(fb.getByText('confirmed')).toBeVisible({ timeout: 60_000 });

  // Both sessions watch the executions converge (polling, no reload).
  await a.goto('/p/local-demo/executions'); await b.goto('/p/local-demo/executions');
  for (const page of [a, b]) {
    await expect.poll(async () => page.request.get('/api/v1/projects/local-demo/executions?limit=200').then((r) => r.json()).then((j) => j.items.filter((x: any) => x.state === 'succeeded').length), { timeout: 90_000 }).toBeGreaterThanOrEqual(2);
  }
  const ev = await a.request.get('/api/v1/projects/local-demo/events?event=JobCompleted&limit=200').then((r) => r.json());
  const byJob = new Map<string, number>();
  for (const e of ev.items) if (e.finality !== 'orphaned') byJob.set(e.args.jobId, (byJob.get(e.args.jobId) ?? 0) + 1);
  expect([...byJob.values()].every((n) => n === 1)).toBe(true);
  await ctxA.close(); await ctxB.close();
});

test('wallet rejection and wrong network never leave a pending business operation', async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    (window as any).ethereum = { request: async ({ method }: any) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'];
      if (method === 'eth_chainId') return (window as any).__chain ?? '0x7a69';
      if (method === 'eth_sendTransaction') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      throw new Error('unsupported');
    }, on() {}, removeListener() {} };
  });
  const page = await ctx.newPage();
  await signIn(page, 'demo-owner');
  const form = await openRequestJob(page);
  await form.getByLabel('input').fill('42');
  await form.getByRole('button', { name: 'Sign & send' }).click();
  await expect(form.getByText('You rejected the request in the wallet.')).toBeVisible();
  await page.evaluate(() => { (window as any).__chain = '0x190f1ca9'; }); // Portaldot chain id while project is on Anvil
  await form.getByRole('button', { name: 'Sign & send' }).click();
  await expect(form.getByText(/Wallet is on chain 420420777/)).toBeVisible();
  const intents = await page.request.get('/api/v1/projects/local-demo/wallet-intents').then((r) => r.json());
  expect(intents.items[0].state).toBe('rejected');
  await ctx.close();
});

test('public visitor can read but every write control is absent or refused', async ({ page }) => {
  await page.goto('/p/local-demo/executions');
  await expect(page.getByRole('heading', { name: 'Executions' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Replay|Cancel/ })).toHaveCount(0);
  const r = await page.request.post('/api/v1/projects/local-demo/connectors', { data: { name: 'x', url: 'https://example.com' } });
  expect(r.status()).toBe(401);
});
