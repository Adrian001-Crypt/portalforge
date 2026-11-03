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
 * Notifications fire only for new or re-opened incidents.
 */
export function raiseIncident(db: Db, r: RaiseInput, clock: () => number = Date.now): { id: string; isNew: boolean; reopened: boolean } {
  const t = now();
  const res = db.tx(() => {
    const open = db.get(`SELECT * FROM incidents WHERE fingerprint = ? AND state IN ('open','acknowledged') ORDER BY first_seen DESC LIMIT 1`, r.fingerprint);
    if (open) {
      const sev = SEV_RANK[r.severity] > SEV_RANK[open.severity as Severity] ? r.severity : open.severity;
      db.run(`UPDATE incidents SET count = count + 1, last_seen = ?, severity = ?, facts = ?, inference = ?, suggestion = ? WHERE id = ?`, t, sev, json(r.diagnosis.facts), json(r.diagnosis.inference), json(r.diagnosis.suggestion), open.id);
      return { id: open.id as string, isNew: false, reopened: false };
    }
    const recent = db.get(`SELECT * FROM incidents WHERE fingerprint = ? AND state = 'resolved' AND cooldown_until > ? ORDER BY resolved_at DESC LIMIT 1`, r.fingerprint, clock());
    if (recent) {
      db.run(`UPDATE incidents SET state = 'open', count = count + 1, last_seen = ?, facts = ?, inference = ?, suggestion = ?, resolved_at = NULL, resolved_by = NULL WHERE id = ?`, t, json(r.diagnosis.facts), json(r.diagnosis.inference), json(r.diagnosis.suggestion), recent.id);
      db.run(`INSERT INTO incident_events (incident_id, at, kind, actor, detail) VALUES (?, ?, 'reopened', 'system', ?)`, recent.id, t, json({ title: r.title }));
      return { id: recent.id as string, isNew: false, reopened: true };
    }
    const id = newId('inc');
    db.run(`INSERT INTO incidents (id, project_id, network_id, fingerprint, kind, severity, state, title, facts, inference, suggestion, refs, first_seen, last_seen, cooldown_until)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, NULL)`, id, r.projectId ?? null, r.networkId ?? null, r.fingerprint, r.kind, r.severity, r.title,
      json(r.diagnosis.facts), json(r.diagnosis.inference), json(r.diagnosis.suggestion), json(r.refs ?? []), t, t);
    db.run(`INSERT INTO incident_events (incident_id, at, kind, actor, detail) VALUES (?, ?, 'opened', 'system', ?)`, id, t, json({ title: r.title, severity: r.severity }));
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

/** Deliver new/re-opened incidents to project webhook channels (via SSRF-checked connectors). */
export async function deliverNotifications(db: Db, incidentId: string, opts: { fetchImpl?: typeof fetch } = {}) {
  const inc = db.get('SELECT * FROM incidents WHERE id = ?', incidentId);
  if (!inc?.project_id) return 0;
  const chans = db.all(`SELECT n.*, c.url, c.allow_private_host FROM notification_channels n JOIN connectors c ON c.project_id = n.project_id AND c.name = n.connector WHERE n.project_id = ?`, inc.project_id);
  let sent = 0;
  for (const ch of chans) {
    if (SEV_RANK[inc.severity as Severity] < SEV_RANK[ch.min_severity as Severity]) continue;
    const payload = { type: 'portalforge.incident', id: inc.id, kind: inc.kind, severity: inc.severity, state: inc.state, title: inc.title, facts: parse(inc.facts), firstSeen: inc.first_seen, lastSeen: inc.last_seen, count: inc.count };
    const r = await safeFetch(ch.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }, { allowPrivate: !!ch.allow_private_host, timeoutMs: 5_000, fetchImpl: opts.fetchImpl }).catch((e) => ({ error: (e as Error).message }));
    const ok = 'status' in r && r.status >= 200 && r.status < 300;
    db.run('INSERT INTO notifications (incident_id, channel_id, status, response_code, error, at) VALUES (?, ?, ?, ?, ?, ?)', inc.id, ch.id, ok ? 'delivered' : 'failed', 'status' in r ? r.status : null, 'error' in r ? r.error : null, now());
    if (ok) sent++;
  }
  return sent;
}
