import { randomBytes, createHash } from 'node:crypto';
export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
