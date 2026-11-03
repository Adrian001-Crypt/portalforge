import { type Db, parse } from '@portalforge/store';
import type { Signal } from '@portalforge/workflow-engine';
import { raiseIncident, resolveByFingerprint, resolveByPrefix, type RaiseInput } from './incidents';
import { endpointStats } from './health';

export interface RuleThresholds { unreachableSamples: number; stallMs: number; finalityLagBlocks: number; indexerLagBlocks: number; indexerStaleMs: number; consecutiveFailures: number }
export const DEFAULT_THRESHOLDS: RuleThresholds = { unreachableSamples: 3, stallMs: 90_000, finalityLagBlocks: 30, indexerLagBlocks: 200, indexerStaleMs: 120_000, consecutiveFailures: 3 };

type Raise = (r: RaiseInput) => void;

/**
 * Rule-based diagnosis over stored observations. Each rule separates facts (with refs), the
 * rule's inference, and suggested recovery steps. Rules never act on the chain.
 */
export function evaluateNetworkRules(db: Db, networkId: string, raise: Raise, t: RuleThresholds = DEFAULT_THRESHOLDS, nowMs = Date.now()) {
  const eps = db.all('SELECT * FROM rpc_endpoints WHERE network_id = ?', networkId);
  const heads: { id: string; iface: string; head: number | null; at: number | null; hash: string | null }[] = [];
  for (const ep of eps) {
    const recent = db.all('SELECT * FROM rpc_samples WHERE endpoint_id = ? ORDER BY at DESC LIMIT ?', ep.id, Math.max(t.unreachableSamples, 20));
    const fp = `rpc_unreachable:${ep.id}`;
    const failing = recent.slice(0, t.unreachableSamples);
    if (failing.length >= t.unreachableSamples && failing.every((s) => !s.ok)) {
      raise({ fingerprint: fp, kind: 'rpc_unreachable', severity: 'critical', networkId, title: `${ep.label} unreachable`, refs: [{ type: 'rpc_endpoint', id: ep.id }], cooldownMs: 120_000,
        diagnosis: {
          facts: [{ label: 'endpoint', value: ep.url }, { label: 'consecutive failed samples', value: String(failing.length) }, { label: 'last error', value: failing[0].error ?? '' }, { label: 'last success', value: recent.find((s) => s.ok) ? new Date(recent.find((s) => s.ok)!.at).toISOString() : 'none in window' }],
          inference: { source: 'rule:rpc_unreachable', text: `The last ${failing.length} probes failed. This is an RPC/transport failure observed from this host; it does not by itself prove the chain stopped.` },
          suggestion: ['Check the same method from another network location (curl eth_blockNumber).', 'Compare with the other registered endpoint for this network.', 'Indexer cursors do not advance while reads fail; no data is lost — they resume from the persisted cursor.'],
        } });
    } else if (recent[0]?.ok) resolveByFingerprint(db, fp, 'system', 'endpoint answered again');
    const okRows = recent.filter((s) => s.ok);
    if (okRows[0]) heads.push({ id: ep.id, iface: ep.interface, head: okRows[0].head, at: okRows[0].at, hash: okRows[0].head_hash });
    // Block production stall per endpoint (head unchanged for stallMs across ≥3 ok samples)
    const window = db.all('SELECT * FROM rpc_samples WHERE endpoint_id = ? AND ok = 1 AND at >= ? ORDER BY at', ep.id, nowMs - t.stallMs);
    const sfp = `head_stalled:${ep.id}`;
    if (window.length >= 3 && window[0].head === window.at(-1)!.head && window.at(-1)!.at - window[0].at >= t.stallMs * 0.8) {
      const others = eps.filter((o) => o.id !== ep.id && o.interface === ep.interface);
      const otherHeads = others.map((o) => db.get('SELECT head FROM rpc_samples WHERE endpoint_id = ? AND ok = 1 ORDER BY at DESC LIMIT 1', o.id)?.head).filter((h) => h != null);
      const nodeBehind = otherHeads.some((h) => h > window[0].head);
      raise({ fingerprint: sfp, kind: nodeBehind ? 'node_lagging' : 'block_stalled', severity: 'critical', networkId, title: nodeBehind ? `${ep.label} is behind other endpoints` : `No new blocks on ${ep.label}`, refs: [{ type: 'rpc_endpoint', id: ep.id }], cooldownMs: 300_000,
        diagnosis: {
          facts: [{ label: 'head', value: String(window[0].head) }, { label: 'unchanged for', value: `${Math.round((window.at(-1)!.at - window[0].at) / 1000)}s over ${window.length} samples` }, { label: 'other endpoints', value: otherHeads.length ? otherHeads.join(', ') : 'none registered' }],
          inference: nodeBehind ? { source: 'rule:node_lagging', text: 'Another endpoint reports a higher head, so this endpoint (not the chain) is behind.' } : { source: 'rule:block_stalled', text: otherHeads.length ? 'All endpoints report the same head: the chain appears to have stopped producing blocks.' : 'Only one endpoint is registered, so "node behind" and "chain halted" cannot be distinguished.' },
          suggestion: nodeBehind ? ['Route reads to the healthy endpoint.', 'Ask the node operator to check peers/sync.'] : ['Check the Node Console and Discord for a network halt notice.', 'Register a second endpoint to distinguish node lag from chain halt.'],
        } });
    } else if (window.length >= 2 && window[0].head !== window.at(-1)!.head) resolveByFingerprint(db, sfp, 'system', 'head advancing');
    // Finality lag
    const last = okRows[0];
    const ffp = `finality_lag:${ep.id}`;
    if (last && last.finalized != null && last.head - last.finalized > t.finalityLagBlocks) {
      raise({ fingerprint: ffp, kind: 'finality_lag', severity: 'warning', networkId, title: `Finality lagging on ${ep.label}`, refs: [{ type: 'rpc_endpoint', id: ep.id }], cooldownMs: 300_000,
        diagnosis: { facts: [{ label: 'best', value: String(last.head) }, { label: 'finalized', value: String(last.finalized) }, { label: 'lag', value: `${last.head - last.finalized} blocks (threshold ${t.finalityLagBlocks})` }],
          inference: { source: 'rule:finality_lag', text: 'GRANDPA finality is not keeping up with block production. Workflows gated on "finalized" will wait.' },
          suggestion: ['Keep event triggers at minFinality "safe" or "finalized" — do not lower them to make progress.', 'Watch for reorgs of unfinalized blocks in the Event Explorer.'] } });
    } else if (last) resolveByFingerprint(db, ffp, 'system', 'finality lag back under threshold');
    // Runtime upgrade (native endpoints)
    if (ep.interface === 'native') {
      const specs = db.all('SELECT DISTINCT spec_version FROM rpc_samples WHERE endpoint_id = ? AND spec_version IS NOT NULL ORDER BY at', ep.id).map((r) => r.spec_version);
      if (specs.length > 1) raise({ fingerprint: `runtime_upgrade:${networkId}:${specs.at(-1)}`, kind: 'runtime_upgrade', severity: 'warning', networkId, title: `Runtime upgraded to spec ${specs.at(-1)}`, refs: [{ type: 'rpc_endpoint', id: ep.id }],
        diagnosis: { facts: [{ label: 'spec versions seen', value: specs.join(' → ') }], inference: { source: 'rule:runtime_upgrade', text: 'Native events are decoded per block with that block’s metadata; new blocks use the new decoder version automatically.' }, suggestion: ['Re-run the capability probe (pf network inspect) and compare.', 'Check decode errors in the Event Explorer for the new spec.'] } });
    }
  }
  // Same-height hash divergence between EVM endpoints
  const evmHeads = heads.filter((h) => h.iface === 'evm' && h.head != null);
  if (evmHeads.length > 1) {
    const byHead = new Map<number, Set<string>>();
    for (const h of evmHeads) { const s = byHead.get(h.head!) ?? new Set(); if (h.hash) s.add(h.hash); byHead.set(h.head!, s); }
    for (const [n, hashes] of byHead) if (hashes.size > 1) raise({ fingerprint: `hash_divergence:${networkId}:${n}`, kind: 'hash_divergence', severity: 'critical', networkId, title: `Endpoints disagree on block #${n}`, diagnosis: { facts: [{ label: 'hashes', value: [...hashes].join(', ') }], inference: { source: 'rule:hash_divergence', text: 'Two endpoints report different blocks at the same height: a fork or a misconfigured endpoint.' }, suggestion: ['Pause write workflows on this network.', 'Identify which endpoint follows the finalized chain.'] } });
  }
}

export function evaluateIndexerRules(db: Db, raise: Raise, t: RuleThresholds = DEFAULT_THRESHOLDS, nowMs = Date.now()) {
  for (const c of db.all('SELECT * FROM cursors')) {
    const fp = `indexer_lag:${c.stream_id}`;
    const lag = c.head_seen != null ? c.head_seen - (c.next_block - 1) : null;
    const stale = c.last_success_at ? nowMs - Date.parse(c.last_success_at) : null;
    if ((lag != null && lag > t.indexerLagBlocks) || (stale != null && stale > t.indexerStaleMs && c.last_error)) {
      raise({ fingerprint: fp, kind: 'indexer_lag', severity: 'warning', networkId: c.network_id, title: `Indexer behind on ${c.stream_id}`, refs: [{ type: 'cursor', id: c.stream_id }], cooldownMs: 300_000,
        diagnosis: { facts: [{ label: 'next block', value: String(c.next_block) }, { label: 'head seen', value: String(c.head_seen) }, { label: 'lag', value: lag == null ? 'unknown' : `${lag} blocks` }, { label: 'last error', value: c.last_error ?? 'none' }, { label: 'last success', value: c.last_success_at ?? 'never' }],
          inference: { source: 'rule:indexer_lag', text: c.last_error ? 'Reads are failing; the cursor holds position until they succeed (no gap is created).' : 'The indexer is backfilling; lag should shrink each tick.' },
          suggestion: ['Check the RPC incident list for the same network.', 'If lag keeps growing without errors, lower the chunk size or add an endpoint.'] } });
    } else resolveByFingerprint(db, fp, 'system', 'indexer caught up');
  }
}

/** Contract code drift: registered deployments whose live code hash no longer matches. Called by the monitor with fresh reads. */
export function raiseCodeMismatch(raise: Raise, c: { id: string; alias: string; address: string; networkId: string; projectId: string; expected: string; actual: string | null }) {
  raise({ fingerprint: `code_mismatch:${c.id}`, kind: 'deployment_code_mismatch', severity: 'critical', projectId: c.projectId, networkId: c.networkId, title: `Code at ${c.alias} does not match its deployment manifest`, refs: [{ type: 'contract', id: c.id }],
    diagnosis: { facts: [{ label: 'address', value: c.address }, { label: 'expected code hash', value: c.expected }, { label: 'live code hash', value: c.actual ?? 'no code' }], inference: { source: 'rule:code_mismatch', text: 'The registered address no longer runs the verified artifact (wrong address, network, or redeploy).' }, suggestion: ['Run pf deployment verify for this manifest.', 'Disable write workflows targeting this contract until resolved.'] } });
}

/** Map engine signals to incidents (aggregated per workflow/contract). */
export function signalToIncident(db: Db, s: Signal, t: RuleThresholds = DEFAULT_THRESHOLDS) {
  const raise = (r: RaiseInput) => raiseIncident(db, r);
  if (s.kind === 'dead_letter' || s.kind === 'execution_failed') {
    const recent = db.all(`SELECT state FROM executions WHERE workflow_id = ? AND state IN ('succeeded','failed','dead_letter') ORDER BY finished_at DESC LIMIT ?`, s.workflowId, t.consecutiveFailures);
    const wf = db.get('SELECT name FROM workflows WHERE id = ?', s.workflowId);
    if (recent.length >= t.consecutiveFailures && recent.every((r) => r.state !== 'succeeded')) {
      raise({ fingerprint: `workflow_failures:${s.workflowId}`, kind: 'workflow_failures', severity: 'critical', projectId: s.projectId, title: `${wf?.name ?? s.workflowId}: ${t.consecutiveFailures} consecutive failures`, refs: [{ type: 'workflow', id: s.workflowId }, { type: 'execution', id: s.executionId }], cooldownMs: 600_000,
        diagnosis: { facts: [{ label: 'last execution', value: s.executionId, ref: `/executions/${s.executionId}` }, { label: 'last error', value: s.detail }], inference: { source: 'rule:workflow_failures', text: 'Failures are consecutive, so this is likely systemic (connector, policy, funds) rather than one bad input.' }, suggestion: ['Open the latest execution trace and read the failing step attempt.', 'Fix the cause, then replay dead-lettered executions from failure.'] } });
    }
  }
  if (s.kind === 'succeeded') {
    resolveByFingerprint(db, `workflow_failures:${s.workflowId}`, 'system', `execution ${s.executionId} succeeded`);
    // An uncertain side effect that was later reconciled is no longer an open problem.
    resolveByPrefix(db, `unknown_outcome:${s.executionId}:`, 'system', 'outcome reconciled; execution succeeded');
  }
  if (s.kind === 'contract_revert') raise({ fingerprint: `contract_revert:${s.workflowId}:${s.stepId}`, kind: 'contract_revert', severity: 'warning', projectId: s.projectId, title: `Contract call reverted in ${s.stepId}`, refs: [{ type: 'execution', id: s.executionId }], cooldownMs: 600_000,
    diagnosis: { facts: [{ label: 'execution', value: s.executionId, ref: `/executions/${s.executionId}` }, { label: 'detail', value: s.detail }], inference: { source: 'rule:contract_revert', text: 'The simulation or receipt reverted; the executor did not retry because a revert is deterministic for the same state.' }, suggestion: ['Read the decoded revert reason in the step attempt.', 'Check on-chain permissions (executor address) on the Contract page.'] } });
  if (s.kind === 'unknown_outcome') raise({ fingerprint: `unknown_outcome:${s.executionId}:${s.stepId}`, kind: 'unknown_outcome', severity: 'warning', projectId: s.projectId, title: `Outcome unknown for ${s.stepId}`, refs: [{ type: 'execution', id: s.executionId }], cooldownMs: 600_000,
    diagnosis: { facts: [{ label: 'execution', value: s.executionId, ref: `/executions/${s.executionId}` }, { label: 'detail', value: s.detail }], inference: { source: 'rule:unknown_outcome', text: 'A side effect may or may not have happened. PortalForge queries the target before any retry and never resends blindly.' }, suggestion: ['Wait for automatic reconciliation (query-before-retry).', 'If marked "operator action required", check the receiver and resolve the step manually.'] } });
  if (s.kind === 'trigger_orphaned') raise({ fingerprint: `trigger_orphaned:${s.executionId}`, kind: 'reorg', severity: 'warning', projectId: s.projectId, title: 'Trigger event orphaned by a reorg', refs: [{ type: 'execution', id: s.executionId }], diagnosis: { facts: [{ label: 'execution', value: s.executionId }, { label: 'detail', value: s.detail }], inference: { source: 'rule:reorg', text: 'The event that started this execution is no longer on the canonical chain.' }, suggestion: ['Queued executions are cancelled automatically; started ones are cancelled at the next step boundary.'] } });
  void parse; void endpointStats;
}
