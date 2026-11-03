/**
 * Application-layer roles. These control who may operate PortalForge; they are NOT on-chain
 * permissions. The console shows both side by side (platform role vs contract role).
 */
export const ROLES = ['owner', 'developer', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  'project.read': ['owner', 'developer', 'operator', 'viewer'],
  'project.update': ['owner'],
  'project.members': ['owner'],
  'project.export': ['owner', 'developer'],
  'resource.write': ['owner', 'developer'],
  'workflow.write': ['owner', 'developer'],
  'workflow.run': ['owner', 'developer', 'operator'],
  'execution.control': ['owner', 'operator'],
  'approval.decide': ['owner', 'operator'],
  'incident.manage': ['owner', 'operator'],
  'rpc.write': ['owner', 'operator'],
  'apikey.manage': ['owner'],
  'evidence.write': ['owner', 'developer', 'operator'],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export const can = (role: Role | null | undefined, p: Permission) =>
  !!role && (PERMISSIONS[p] as readonly Role[]).includes(role);

/** API key scopes are a subset of permissions; a key never implies `owner`. */
export const API_SCOPES = ['read', 'events:read', 'workflow:run', 'evidence:write'] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const scopeAllows = (scopes: readonly string[], p: Permission): boolean => {
  if (p.endsWith('.read') || p === 'project.read') return scopes.includes('read') || scopes.includes('events:read');
  if (p === 'workflow.run') return scopes.includes('workflow:run');
  if (p === 'evidence.write') return scopes.includes('evidence:write');
  return false;
};
