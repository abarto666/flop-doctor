import { BlockList, isIP } from 'node:net';

function subnets(entries, type) {
  const list = new BlockList();
  for (const [address, prefix] of entries) list.addSubnet(address, prefix, type);
  return list;
}

const IPV4 = subnets([
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
], 'ipv4');
const FAKE = subnets([['198.18.0.0', 15]], 'ipv4');
const IPV6_GLOBAL = subnets([['2000::', 3]], 'ipv6');
const IPV6_RESERVED = subnets([
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
], 'ipv6');
const MAPPED = subnets([['::ffff:0:0', 96]], 'ipv6');

export function classifyIp(address) {
  if (typeof address !== 'string' || address.includes('%')) return 'invalid';
  const family = isIP(address);
  if (!family) return 'invalid';
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (family === 4 || MAPPED.check(address, type)) {
    if (FAKE.check(address, type)) return 'fake';
    return IPV4.check(address, type) ? 'private' : 'public';
  }
  return !IPV6_GLOBAL.check(address, type) || IPV6_RESERVED.check(address, type) ? 'private' : 'public';
}
