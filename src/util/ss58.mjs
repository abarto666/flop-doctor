import { createHash, timingSafeEqual } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function isSs58(address) {
  if (typeof address !== 'string' || address.length < 35 || address.length > 50) return false;
  let decoded = 0n;
  for (const char of address) {
    const digit = ALPHABET.indexOf(char);
    if (digit === -1) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  let hex = decoded === 0n ? '' : decoded.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const zeros = address.match(/^1*/)[0].length;
  const bytes = Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, 'hex')]);
  const first = bytes[0];
  if (first === undefined || first >= 128) return false;
  const prefixBytes = first < 64 ? 1 : 2;
  if (bytes.length !== prefixBytes + 32 + 2) return false;
  const prefix = prefixBytes === 1 ? first : ((first & 63) << 2) | (bytes[1] >> 6) | ((bytes[1] & 63) << 8);
  if (prefix === 46 || prefix === 47 || (prefixBytes === 2 && prefix < 64)) return false;
  const checksum = createHash('blake2b512').update('SS58PRE').update(bytes.subarray(0, -2)).digest().subarray(0, 2);
  return timingSafeEqual(checksum, bytes.subarray(-2));
}
