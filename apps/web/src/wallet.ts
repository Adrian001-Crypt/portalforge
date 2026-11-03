import { api, ApiError } from './api';

/**
 * Browser-wallet signing protocol (EIP-1193):
 *  1. read chain + account from the wallet; refuse if the chain is not the project network
 *  2. persist a wallet intent on the server — if that fails, the wallet is NOT opened
 *  3. eth_sendTransaction; on hash → record "submitted"; on 4001 → "rejected"; on anything else → "unknown"
 *     (kept for reconciliation: the tx may still have been sent)
 *  4. poll /refresh until confirmed / failed / replaced
 * Other tabs are told via BroadcastChannel; the server allows one open intent per account.
 */
type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<any>; on?: (e: string, f: (...a: any[]) => void) => void; removeListener?: (e: string, f: (...a: any[]) => void) => void };
export const wallet = (): Eip1193 | null => (window as any).ethereum ?? null;
const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('portalforge-wallet') : null;
export const onWalletBroadcast = (f: (m: any) => void) => { if (!bc) return () => {}; const h = (e: MessageEvent) => f(e.data); bc.addEventListener('message', h); return () => bc.removeEventListener('message', h); };

export async function connect(): Promise<{ account: string; chainId: number }> {
  const w = wallet();
  if (!w) throw new ApiError(0, 'NO_WALLET', 'No EIP-1193 wallet found (install MetaMask or a compatible wallet).');
  const [account] = await w.request({ method: 'eth_requestAccounts' });
  const chainId = Number.parseInt(await w.request({ method: 'eth_chainId' }), 16);
  return { account: account.toLowerCase(), chainId };
}

export async function switchChain(net: { chainId: number; name: string; rpcUrl: string; symbol: string }) {
  const w = wallet();
  if (!w) throw new ApiError(0, 'NO_WALLET', 'No wallet');
  const hex = `0x${net.chainId.toString(16)}`;
  try { await w.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }); }
  catch (e: any) {
    if (e?.code !== 4902) throw e;
    await w.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hex, chainName: net.name, rpcUrls: [net.rpcUrl], nativeCurrency: { name: net.symbol, symbol: net.symbol, decimals: 18 } }] });
  }
}

export interface SendInput { projectId: string; kind: 'deploy' | 'call'; to?: string; data: string; contractAlias?: string; functionName?: string; args?: unknown[]; note?: string; expectedChainId: number }
export type Progress = (s: { phase: 'checking' | 'persisting' | 'signing' | 'submitted' | 'confirmed' | 'failed' | 'rejected' | 'unknown' | 'replaced'; intentId?: string; txHash?: string; message?: string }) => void;

export async function sendWithIntent(input: SendInput, progress: Progress) {
  progress({ phase: 'checking' });
  const { account, chainId } = await connect();
  if (chainId !== input.expectedChainId) throw new ApiError(0, 'NETWORK_MISMATCH', `Wallet is on chain ${chainId}; switch to ${input.expectedChainId} first.`);
  progress({ phase: 'persisting' });
  const intent = await api<{ id: string; expectedNonce: number; balance: string }>(`/projects/${input.projectId}/wallet-intents`, { method: 'POST', body: { kind: input.kind, chainId, from: account, to: input.to, contractAlias: input.contractAlias, functionName: input.functionName, args: input.args, data: input.data, note: input.note } });
  bc?.postMessage({ type: 'intent-open', id: intent.id, account });
  progress({ phase: 'signing', intentId: intent.id });
  const w = wallet()!;
  // Re-check right before signing: the user may have switched account or chain while the intent was saved.
  const [nowAccount] = await w.request({ method: 'eth_accounts' });
  const nowChain = Number.parseInt(await w.request({ method: 'eth_chainId' }), 16);
  if (nowAccount?.toLowerCase() !== account || nowChain !== chainId) {
    await api(`/wallet-intents/${intent.id}`, { method: 'PATCH', body: { outcome: 'rejected', error: 'account or chain changed before signing' } });
    throw new ApiError(0, 'CHANGED', 'Account or network changed before signing. Nothing was sent.');
  }
  let hash: string;
  try {
    hash = await w.request({ method: 'eth_sendTransaction', params: [{ from: account, ...(input.to ? { to: input.to } : {}), data: input.data, value: '0x0' }] });
  } catch (e: any) {
    const rejected = e?.code === 4001;
    await api(`/wallet-intents/${intent.id}`, { method: 'PATCH', body: { outcome: rejected ? 'rejected' : 'unknown', error: String(e?.message ?? e).slice(0, 400) } }).catch(() => {});
    bc?.postMessage({ type: 'intent-closed', id: intent.id });
    progress({ phase: rejected ? 'rejected' : 'unknown', intentId: intent.id, message: rejected ? 'You rejected the request in the wallet.' : 'The wallet returned an error. The transaction may still have been sent — use Reconcile.' });
    return { intentId: intent.id, state: rejected ? 'rejected' : 'unknown' };
  }
  try { await api(`/wallet-intents/${intent.id}`, { method: 'PATCH', body: { outcome: 'submitted', txHash: hash } }); }
  catch { /* the hash is not persisted yet; /refresh recovers it from (from, nonce) */ }
  progress({ phase: 'submitted', intentId: intent.id, txHash: hash });
  bc?.postMessage({ type: 'intent-closed', id: intent.id });
  return { intentId: intent.id, txHash: hash, ...(await waitIntent(intent.id, progress)) };
}

export async function waitIntent(id: string, progress: Progress, timeoutMs = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const w = await api<any>(`/wallet-intents/${id}/refresh`, { method: 'POST' });
      if (['confirmed', 'failed', 'replaced'].includes(w.state)) { progress({ phase: w.state, intentId: id, txHash: w.tx_hash, message: w.error ?? undefined }); return { state: w.state, intent: w }; }
    } catch { /* transient; keep polling */ }
  }
  progress({ phase: 'unknown', intentId: id, message: 'Still not confirmed. It may confirm later — Reconcile from the list.' });
  return { state: 'unknown' };
}
