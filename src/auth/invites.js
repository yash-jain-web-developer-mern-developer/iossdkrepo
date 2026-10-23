// Invite codes for the private beta: MA-XXXX-XXXX-XXXX from an alphabet without look-alike characters (about 60 bits).
// Only a hash is stored; the code is shown to the admin once. Matching ignores case, spaces and dashes.
import { createHash, randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const hashCode = (c) => createHash('sha256').update('mobiad-invite:' + normalizeCode(c)).digest('hex');
export function newCode() {
  const part = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `MA-${part()}-${part()}-${part()}`;
}
