import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { PfError } from '@portalforge/domain';

/**
 * Outbound HTTP policy for webhook connectors (SSRF / DNS rebinding):
 *  - only http(s), no credentials in URL, standard ports or explicit allowlist
 *  - the hostname is resolved at request time and EVERY resolved address must be public,
 *    unless the connector was created with allow_private_host by a platform admin (local demo)
 *  - redirects are never followed (fetch redirect: 'manual' → treated as failure)
 */
const PRIVATE_V4 = [
  [0x00000000, 0xff000000], [0x0a000000, 0xff000000], [0x64400000, 0xffc00000], [0x7f000000, 0xff000000],
  [0xa9fe0000, 0xffff0000], [0xac100000, 0xfff00000], [0xc0000000, 0xffffff00], [0xc0a80000, 0xffff0000],
  [0xc6120000, 0xfffe0000], [0xe0000000, 0xf0000000], [0xf0000000, 0xf0000000],
] as const;

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
    return PRIVATE_V4.some(([net, mask]) => ((n & mask) >>> 0) === net);
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
}

export function parseConnectorUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new PfError('UNSAFE_TARGET', 'invalid URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new PfError('UNSAFE_TARGET', 'only http(s) connectors are allowed');
  if (u.username || u.password) throw new PfError('UNSAFE_TARGET', 'credentials in URL are not allowed');
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port) && !isLoopbackName(u.hostname)) throw new PfError('UNSAFE_TARGET', `port ${u.port} not allowed`);
  return u;
}

const isLoopbackName = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

export async function assertPublicTarget(raw: string, allowPrivate: boolean, resolver: (h: string) => Promise<{ address: string }[]> = (h) => lookup(h, { all: true, verbatim: true })) {
  const u = parseConnectorUrl(raw);
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await resolver(host).catch(() => { throw new PfError('UNSAFE_TARGET', `cannot resolve ${host}`); });
  if (!addrs.length) throw new PfError('UNSAFE_TARGET', `no addresses for ${host}`);
  for (const a of addrs) if (isPrivateAddress(a.address)) throw new PfError('UNSAFE_TARGET', `${host} resolves to a private address`);
  return u;
}
