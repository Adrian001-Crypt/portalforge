import { PfError } from '@portalforge/domain';
import { type Db, json, now, parse, newId } from '@portalforge/store';
import { safeFetch } from '@portalforge/workflow-engine';

export type Severity = 'info' | 'warning' | 'critical';
export interface Fact { label: string; value: string; ref?: string }
export interface Diagnosis {
  /** Observed, verifiable data points with links to raw evidence. */
  facts: Fact[];
  /** What the rule concludes from the facts. Always labelled with its source (rule id or model). */
  inference: { source: string; text: string };
  /** Ordered recovery steps for a human. Never executed automatically. */
  suggestion: string[];
}
export interface RaiseInput {
  fingerprint: string; kind: string; severity: Severity; title: string; diagnosis: Diagnosis;
  projectId?: string | null; networkId?: string | null; refs?: { type: string; id: string }[]; cooldownMs?: number;
}

const SEV_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

/**
 * Raise or aggregate an incident. Open/acknowledged incidents with the same fingerprint are aggregated
 * (count, last_seen); a resolved one inside its cooldown is re-opened instead of duplicated.
 * New and re-opened incidents, and severity escalations, queue webhook deliveries in the same transaction,
 * so a crash cannot lose one and repeats of an open incident cannot send another.
 */
export function raiseIncident(db: Db, r: RaiseInput, clock: () => number = Date.now): { id: string; isNew: boolean; reopened: boolean } {
  const t = now();
  const res = db.tx(() => {
    const open = db.get(`SELECT * FROM incidents WHERE fingerprint = ? AND state IN ('open','acknowledged') ORDER BY first_seen DESC LIMIT 1`, r.fingerprint);
    if (open) {
      const sev = SEV_RANK[r.severity] > SEV_RANK[open.severity as Severity] ? r.severity : open.severity;
      db.run(`UPDATE incidents SET count = count + 1, last_seen = ?, severity = ?, facts = ?, inference = ?, suggestion = ? WHERE id = ?`, t, sev, json(r.diagnosis.facts), json(r.diagnosis.inference), json(r.diagnosis.suggestion), open.id);
      if (sev !== open.severity) enqueueDeliveries(db, open.id, clock); // channels above the old severity have not heard of it yet
      return { id: open.id as string, isNew: false, reopened: false };
    }
    const recent = db.get(`SELECT * FROM incidents WHERE fingerprint = ? AND state = 'resolved' AND cooldown_until > ? ORDER BY resolved_at DESC LIMIT 1`, r.fingerprint, clock());
    if (recent) {
      db.run(`UPDATE incidents SET state = 'open', generation = generation + 1, count = count + 1, last_seen = ?, facts = ?, inference = ?, suggestion = ?, resolved_at = NULL, resolved_by = NULL WHERE id = ?`, t, json(r.diagnosis.facts), json(r.diagnosis.inference), json(r.diagnosis.suggestion), recent.id);
      db.run(`INSERT INTO incident_events (incident_id, at, kind, actor, detail) VALUES (?, ?, 'reopened', 'system', ?)`, recent.id, t, json({ title: r.title }));
      enqueueDeliveries(db, recent.id, clock);
      return { id: recent.id as string, isNew: false, reopened: true };
    }
    const id = newId('inc');
    db.run(`INSERT INTO incidents (id, project_id, network_id, fingerprint, kind, severity, state, title, facts, inference, suggestion, refs, first_seen, last_seen, cooldown_until)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, NULL)`, id, r.projectId ?? null, r.networkId ?? null, r.fingerprint, r.kind, r.severity, r.title,
      json(r.diagnosis.facts), json(r.diagnosis.inference), json(r.diagnosis.suggestion), json(r.refs ?? []), t, t);
    db.run(`INSERT INTO incident_events (incident_id, at, kind, actor, detail) VALUES (?, ?, 'opened', 'system', ?)`, id, t, json({ title: r.title, severity: r.severity }));
    enqueueDeliveries(db, id, clock);
    return { id, isNew: true, reopened: false };
  });
  if ((res.isNew || res.reopened) && r.cooldownMs !== undefined) db.run('UPDATE incidents SET cooldown_until = ? WHERE id = ?', clock() + r.cooldownMs, res.id);
  return res;
}

export function resolveByFingerprint(db: Db, fingerprint: string, actor: string, note: string, cooldownMs = 5 * 60_000, clock: () => number = Date.now) {
  const t = now();
  return db.tx(() => {
    const rows = db.all(`SELECT id FROM incidents WHERE fingerprint = ? AND state IN ('open','acknowledged')`, fingerprint);
    for (const r of rows) {
      db.run(`UPDATE incidents SET state = 'resolved', resolved_at = ?, resolved_by = ?, cooldown_until = ? WHERE id = ?`, t, actor, clock() + cooldownMs, r.id);
      db.run(`INSERT INTO incident_events (incident_id, at, kind, actor, detail) VALUES (?, ?, 'resolved', ?, ?)`, r.id, t, actor, json({ note }));
    }
    return rows.length;
  });
}

/** Resolve every open incident whose fingerprint starts with `prefix` (e.g. all unknown-outcome incidents of one execution). */
export function resolveByPrefix(db: Db, prefix: string, actor: string, note: string, clock: () => number = Date.now) {
  const fps = db.all(`SELECT DISTINCT fingerprint FROM incidents WHERE state IN ('open','acknowledged') AND substr(fingerprint, 1, ?) = ?`, prefix.length, prefix).map((r) => r.fingerprint as string);
  return fps.reduce((n, fp) => n + resolveByFingerprint(db, fp, actor, note, 5 * 60_000, clock), 0);
}

export function transitionIncident(db: Db, id: string, action: 'acknowledge' | 'resolve', actor: string, note?: string, clock: () => number = Date.now) {
  const t = now();
  return db.tx(() => {
    const inc = db.get('SELECT * FROM incidents WHERE id = ?', id);
    if (!inc) return null;
    if (action === 'acknowledge' && inc.state === 'open') db.run(`UPDATE incidents SET state = 'acknowledged', acknowledged_by = ?, acknowledged_at = ? WHERE id = ?`, actor, t, id);
    else if (action === 'resolve' && inc.state !== 'resolved') db.run(`UPDATE incidents SET state = 'resolved', resolved_by = ?, resolved_at = ?, cooldown_until = ? WHERE id = ?`, actor, t, clock() + 5 * 60_000, id);
    else return inc;
    db.run(`INSERT INTO incident_events (incident_id, at, kind, actor, detail) VALUES (?, ?, ?, ?, ?)`, id, t, action === 'acknowledge' ? 'acknowledged' : 'resolved', actor, json({ note: note ?? null }));
    return db.get('SELECT * FROM incidents WHERE id = ?', id);
  });
}

export interface DeliveryOptions { workerId: string; maxAttempts?: number; baseBackoffMs?: number; maxBackoffMs?: number; leaseMs?: number; timeoutMs?: number; limit?: number; clock?: () => number; fetchImpl?: typeof fetch }
const DELIVERY_DEFAULTS = { maxAttempts: 5, baseBackoffMs: 15_000, maxBackoffMs: 30 * 60_000, leaseMs: 30_000, timeoutMs: 5_000, limit: 8 };

/**
 * Queue one delivery per matching channel. The key names the incident occurrence, not the attempt: retries reuse it
 * and the stored payload byte for byte, so a receiver can drop repeats. Delivery is at-least-once.
 */
function enqueueDeliveries(db: Db, incidentId: string, clock: () => number) {
  const inc = db.get('SELECT * FROM incidents WHERE id = ?', incidentId);
  if (!inc?.project_id) return;
  for (const ch of db.all('SELECT * FROM notification_channels WHERE project_id = ?', inc.project_id)) {
    if (SEV_RANK[inc.severity as Severity] < SEV_RANK[ch.min_severity as Severity]) continue;
    const key = `${inc.id}:${inc.generation}:${ch.id}`;
    const payload = { type: 'portalforge.incident', deliveryId: key, id: inc.id, occurrence: inc.generation, kind: inc.kind, severity: inc.severity, state: inc.state, title: inc.title, facts: parse(inc.facts), firstSeen: inc.first_seen, lastSeen: inc.last_seen, count: inc.count };
    db.run(`INSERT INTO notifications (incident_id, channel_id, status, at, delivery_key, payload, next_attempt_at) VALUES (?, ?, 'pending', ?, ?, ?, ?) ON CONFLICT (delivery_key) WHERE delivery_key IS NOT NULL DO NOTHING`, inc.id, ch.id, now(), key, JSON.stringify(payload), clock());
  }
}

/** Claim due deliveries under a lease. An expired lease means the worker died mid-request: the outcome is unknown, so it goes again under the same key. */
function claimDeliveries(db: Db, o: Required<Pick<DeliveryOptions, 'workerId' | 'leaseMs' | 'limit' | 'maxAttempts'>>, t: number) {
  return db.tx(() => {
    const due = db.all(`SELECT * FROM notifications WHERE delivery_key IS NOT NULL AND ((status IN ('pending','retrying') AND next_attempt_at <= ?) OR (status = 'sending' AND lease_until <= ?)) ORDER BY next_attempt_at LIMIT ?`, t, t, o.limit);
    const claimed: any[] = [];
    for (const n of due) {
      if (n.attempts >= o.maxAttempts) { db.run(`UPDATE notifications SET status = 'dead', error = ?, lease_until = NULL, at = ? WHERE id = ?`, n.error ?? 'worker lost during the last attempt; outcome unknown', now(), n.id); continue; }
      db.run(`UPDATE notifications SET status = 'sending', attempts = attempts + 1, lease_until = ?, claimed_by = ? WHERE id = ?`, t + o.leaseMs, o.workerId, n.id);
      claimed.push({ ...n, attempts: n.attempts + 1 });
    }
    return claimed;
  });
}

const retryableStatus = (s: number) => s === 408 || s === 425 || s === 429 || s >= 500;

/** Send everything that is due. 2xx delivered · 408/425/429/5xx, timeouts and network errors retry with backoff · other responses and unsafe targets are final. */
export async function deliverDue(db: Db, opts: DeliveryOptions) {
  const o = { ...DELIVERY_DEFAULTS, ...opts };
  const clock = opts.clock ?? Date.now;
  const claimed = claimDeliveries(db, o, clock());
  const counts = { claimed: claimed.length, delivered: 0, retrying: 0, dead: 0 };
  await Promise.all(claimed.map(async (n) => {
    const target = db.get('SELECT c.url, c.allow_private_host FROM notification_channels ch JOIN connectors c ON c.project_id = ch.project_id AND c.name = ch.connector WHERE ch.id = ?', n.channel_id);
    let code: number | null = null; let error: string | null = null; let final = false;
    if (!target) { error = 'channel or connector was removed'; final = true; } else {
      try {
        const r = await safeFetch(target.url, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': n.delivery_key, 'x-portalforge-delivery': n.delivery_key, 'x-portalforge-attempt': String(n.attempts), 'user-agent': 'PortalForge-Webhook/1' }, body: n.payload }, { allowPrivate: !!target.allow_private_host, timeoutMs: o.timeoutMs, fetchImpl: opts.fetchImpl });
        if ('error' in r) error = r.error.slice(0, 200);
        else {
          code = r.status;
          if (r.status < 200 || r.status >= 300) { error = `HTTP ${r.status}`; final = !retryableStatus(r.status); }
        }
      } catch (e) {
        error = (e as Error).message.slice(0, 200);
        final = (e as PfError).code === 'UNSAFE_TARGET';
      }
    }
    const state = error === null ? 'delivered' : final || n.attempts >= o.maxAttempts ? 'dead' : 'retrying';
    const backoff = Math.min(o.maxBackoffMs, o.baseBackoffMs * 4 ** (n.attempts - 1)) * (0.8 + Math.random() * 0.4);
    // A stale worker whose lease was taken over must not overwrite the newer attempt.
    db.run(`UPDATE notifications SET status = ?, response_code = ?, error = ?, at = ?, lease_until = NULL, next_attempt_at = ? WHERE id = ? AND attempts = ? AND claimed_by = ?`, state, code, error, now(), state === 'retrying' ? clock() + Math.round(backoff) : null, n.id, n.attempts, o.workerId);
    counts[state === 'delivered' ? 'delivered' : state === 'retrying' ? 'retrying' : 'dead']++;
  }));
  return counts;
}

/** Operator retry of a delivery that gave up. Same key and payload, fresh attempt budget. */
export function retryDelivery(db: Db, id: number, clock: () => number = Date.now) {
  return db.run(`UPDATE notifications SET status = 'pending', attempts = 0, next_attempt_at = ?, lease_until = NULL WHERE id = ? AND status = 'dead' AND delivery_key IS NOT NULL`, clock(), id);
}
