import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyIp } from '../src/util/netguard.mjs';
import { formatFlop, parseFlop } from '../src/util/planck.mjs';
import { compareSemver, parseSemver } from '../src/util/semver.mjs';
import { isSs58 } from '../src/util/ss58.mjs';
import { ENDPOINT, MINERS, PUBLIC_IP, certificate } from './fixtures/interfaces.mjs';
import { mockError, run, verdict } from './helpers/mock-deps.mjs';

const PRIVATE = ['0.0.0.0', '10.255.255.255', '172.16.1.2', '172.31.255.255', '192.168.1.1', '127.0.0.1',
  '169.254.10.10', '100.64.0.1', '100.127.255.254', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.51.100.1',
  '203.0.113.1', '::', '::1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '3fff::1', '::ffff:10.0.0.1',
  '0:0:0:0:0:ffff:7f00:1', '::ffff:192.0.2.1'];
const probe = (options = {}, url = ENDPOINT, extra = []) => run(['miner', MINERS[0], '--endpoint', url, ...extra], options);

test('06 endpoint: unauthorized probe, redirects, netguard, fake-IP and fail-closed DNS', async () => {
  for (const [http, status, reason] of [
    [301, 'fail', 'redirect'], [302, 'fail', 'redirect'], [303, 'fail', 'redirect'], [307, 'fail', 'redirect'], [308, 'fail', 'redirect'],
    [200, 'fail', 'unauthenticated_access'], [401, 'pass', 'ok'], [403, 'fail', 'unexpected_status'],
  ]) {
    const { report, calls } = await probe({ httpsGet: () => http, resolve6: () => ['2606:4700::1111'] });
    verdict(report, 'endpoint.session_info', status, reason);
    assert.equal(calls.httpsGet.length, 1);
    assert.equal(calls.resolve4.length, 1);
    assert.equal(calls.resolve6.length, 1);
    for (const name of ['httpsGet', 'tlsConnect']) {
      const [[{ ip, hostname, port, authority }]] = calls[name];
      assert.equal(ip, PUBLIC_IP);
      assert.equal(hostname, 'worker-one.example');
      assert.equal(port, 8443);
      assert.equal(authority, 'worker-one.example:8443');
    }
  }
  const scenarios = [
    ...PRIVATE.map((ip) => [{ resolve4: () => [ip] }, ENDPOINT, 'fail', 'private_address', 'operator']),
    [{ resolve6: () => ['::ffff:10.0.0.1'] }, ENDPOINT, 'fail', 'private_address', 'operator'],
    [{ resolve4: () => ['198.18.1.2'] }, ENDPOINT, 'unknown', 'fake_ip_suspected', 'local'],
    [{ resolve6: () => ['::ffff:198.19.255.254'] }, ENDPOINT, 'unknown', 'fake_ip_suspected', 'local'],
    [{ resolve4: () => [] }, ENDPOINT, 'fail', 'no_records', 'operator'],
    [{ resolve4: () => { throw mockError('ENOTFOUND'); } }, ENDPOINT, 'fail', 'no_records', 'operator'],
    [{ resolve6: () => { throw mockError('ESERVFAIL'); } }, ENDPOINT, 'unknown', 'resolver_error', 'local'],
    [{ resolve4: () => { throw mockError('ETIMEOUT'); } }, ENDPOINT, 'unknown', 'resolver_error', 'local'],
    [{}, 'https://host.mesh.ts.net.', 'fail', 'tailscale_domain', 'operator'],
    [{}, 'https://127.1', 'fail', 'ip_literal', 'operator'], [{}, 'https://[::1]', 'fail', 'ip_literal', 'operator'],
  ];
  for (const [overrides, url, status, reason, cause] of scenarios) {
    const { report, calls } = await probe(overrides, url);
    verdict(report, 'endpoint.dns', status, reason, cause);
    verdict(report, 'endpoint.tls', 'unknown', 'skipped_dns');
    verdict(report, 'endpoint.session_info', 'unknown', 'skipped_dns');
    if (reason === 'tailscale_domain' || reason === 'ip_literal') {
      assert.equal(calls.resolve4.length, 0);
      assert.equal(calls.resolve6.length, 0);
    }
    assert.equal(calls.tlsConnect.length, 0);
    assert.equal(calls.httpsGet.length, 0);
  }
  const offline = await probe({ httpsGet: () => { throw mockError('ECONNREFUSED'); } });
  verdict(offline.report, 'endpoint.session_info', 'fail', 'unreachable');
  const ipv6 = await probe({ resolve4: () => [], resolve6: () => ['2606:4700::1111', '2001:4860::8844'] });
  assert.equal(ipv6.calls.tlsConnect[0][0].ip, '2606:4700::1111');
});

test('07 TLS certificate and trust/hostname boundaries', async () => {
  for (const [days, status, reason] of [[15, 'pass', 'ok'], [14, 'warn', 'expiring'],
    [4, 'warn', 'expiring'], [3, 'fail', 'expired_or_imminent']]) {
    const { report } = await probe({ tlsConnect: () => certificate(days) });
    assert.equal(verdict(report, 'endpoint.tls', status, reason).evidence.days_remaining, days);
  }
  const custom = await probe({ tlsConnect: () => certificate(5) }, ENDPOINT, ['--cert-warn-days', '7', '--cert-fail-days', '5']);
  verdict(custom.report, 'endpoint.tls', 'fail', 'expired_or_imminent');
  for (const [code, reason] of [['SELF_SIGNED_CERT_IN_CHAIN', 'untrusted'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'untrusted'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'untrusted'], ['ECONNRESET', 'handshake_failed']]) {
    const { report } = await probe({ tlsConnect: () => { throw mockError(code); } });
    assert.equal(verdict(report, 'endpoint.tls', 'fail', reason).evidence.error_code, code);
    verdict(report, 'endpoint.session_info', 'pass', 'ok');
  }
  const unauthorized = await probe({ tlsConnect: () => ({ ...certificate(99), authorized: false }) });
  verdict(unauthorized.report, 'endpoint.tls', 'fail', 'untrusted');
});

test('15 utilities: SS58 known vectors, SemVer precedence, decimal arithmetic and IP classification', () => {
  for (const address of [...MINERS, 'yNVRL9ET84PfoD77E1amiH96JFkMLFXZ4PNqgkJScmrsxafoi', '111111111111111111111111111111111HC1',
    '5C8Riqh9Lj9Yv3ZKaUMDAzKLVf71VoedSTvuLMnr9KZ8qXiT']) assert.equal(isSs58(address), true, address);
  for (const address of ['', '5bKvd1WHDXXMKqdwJuxPTRz4nL8XrpvFL1ddZvezbvJhHiPk', `${MINERS[0].slice(0, -1)}a`,
    `0${MINERS[0].slice(1)}`, `1${MINERS[0]}`, 'F7NZ', 'a'.repeat(51)]) assert.equal(isSs58(address), false, address);
  const ordering = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (const [index, value] of ordering.entries()) if (index) assert.equal(compareSemver(ordering[index - 1], value), -1);
  assert.equal(compareSemver('1.900719925474099300000.0', '1.900719925474099300001.0'), -1);
  assert.equal(compareSemver('1.2.3+7', '1.2.3+4'), 0);
  for (const version of ['', 'v1.0.0', '1.0', '1.0.0-01', '01.0.0', '1.0.0-']) assert.equal(parseSemver(version), null);
  assert.equal(parseFlop('0.000000000000000001'), 1n);
  assert.equal(parseFlop('0.5'), 500000000000000000n);
  assert.equal(formatFlop(1234567890123456789012345678901234567890n), '1234567890123456789012.34567890123456789');
  assert.equal(formatFlop(-1n), '-0.000000000000000001');
  assert.throws(() => parseFlop('NaN'), TypeError);
  for (const address of PRIVATE) assert.equal(classifyIp(address), 'private', address);
  for (const address of ['198.18.0.0', '198.19.255.255', '::ffff:c612:1']) assert.equal(classifyIp(address), 'fake', address);
  for (const address of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '198.20.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(classifyIp(address), 'public', address);
  for (const address of ['8.8.8', '999.2.3.4', 'fe80::1%en0', 'example.org']) assert.equal(classifyIp(address), 'invalid', address);
});
