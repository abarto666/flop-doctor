const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NUMERIC = /^\d+$/;

export function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = VERSION.exec(value);
  if (!match) return null;
  const pre = match[4]?.split('.') ?? [];
  if (pre.some((part) => NUMERIC.test(part) && part.length > 1 && part.startsWith('0'))) return null;
  return { core: match.slice(1, 4).map(BigInt), pre };
}

const cmp = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export function compareSemver(left, right) {
  const lhs = parseSemver(left);
  const rhs = parseSemver(right);
  if (!lhs || !rhs) throw new TypeError('Invalid semver');
  for (const [index, value] of lhs.core.entries()) {
    const order = cmp(value, rhs.core[index]);
    if (order) return order;
  }
  if (!lhs.pre.length || !rhs.pre.length) return cmp(!lhs.pre.length, !rhs.pre.length);
  for (const [index, part] of lhs.pre.entries()) {
    const other = rhs.pre[index];
    if (other === undefined) return 1;
    const numeric = NUMERIC.test(part);
    const otherNumeric = NUMERIC.test(other);
    const order = numeric && otherNumeric ? cmp(BigInt(part), BigInt(other)) :
      numeric !== otherNumeric ? cmp(otherNumeric, numeric) : cmp(part, other);
    if (order) return order;
  }
  return cmp(lhs.pre.length, rhs.pre.length);
}
