import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MAX_BODY } from '../src/config.mjs';
import { checkFingerprint, reportFingerprint } from '../src/fingerprint.mjs';
import { REGISTRY } from '../src/registry.mjs';
import { aggregate, byGroupIdSubject, check, pass } from '../src/result.mjs';
import { BALANCE, ENDPOINT, GENESIS, HEAD, MINERS, NOW, PUBLIC_IP, hexHeight, rpcResult } from './fixtures/interfaces.mjs';
import { validate } from './helpers/mini-schema.mjs';
import { mockError, row, run, verdict } from './helpers/mock-deps.mjs';

const schema = JSON.parse(readFileSync(new URL('../schema/report.v1.schema.json', import.meta.url), 'utf8'));
const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

test('01 baseline: all checks pass, fixed report contract and formatting', async () => {
  const command = ['check', '--miner', `${MINERS[0]}=${ENDPOINT}`];
  const { report, exit, calls, err } = await run(command);
  assert.equal(exit, 0);
  assert.deepEqual(err, []);
  assert.deepEqual(report.summary, { pass: 35, warn: 0, fail: 0, unknown: 0 });
  assert.equal(report.fingerprint, sha('flop-doctor/v1\ndevnet\nok'));
  assert.equal(report.generated_at, '2026-11-20T08:00:00.000Z');
  assert.deepEqual(validate(schema, report), []);
  assert.deepEqual(report.checks, report.checks.toSorted(byGroupIdSubject));
  assert.equal(calls.fetch.length, 15);
  assert.equal(new Set(calls.fetch.map(({ url, rpc }) => (rpc ? `${url}#${rpc.method}:${JSON.stringify(rpc.params)}` : url))).size, calls.fetch.length);
  assert.deepEqual(Object.keys(REGISTRY).sort(), schema.$defs.check.properties.id.enum.toSorted());
  assert.deepEqual([...new Set(Object.values(REGISTRY).flatMap(({ reasons }) => reasons))].sort(),
    schema.$defs.check.properties.reason.enum.toSorted());
  for (const result of report.checks) assert.ok(REGISTRY[result.id].reasons.includes(result.reason));
  assert.ok(validate(schema, { ...report, extra: 1 }).some((error) => error.includes('unexpected extra')));
  const broken = structuredClone(report);
  broken.checks[0].extra = 1;
  broken.checks[0].evidence.invalid = { nested: true };
  assert.equal(validate(schema, broken).length, 2);

  const text = await run(command, {}, false);
  assert.equal(text.text, `FLOP-DOCTOR PASS fail=0 warn=0 unknown=0 pass=35 fp=${report.fingerprint}`);
  const verbose = await run([...command, '--verbose'], {}, false);
  assert.equal(verbose.text.split('\n').length, 36);
});

test('02 RPC HTTP errors: isolated probe, all RPC calls, stable 502/503 attribution', async () => {
  const probe = (status) => run(['net'], { fetch: ({ key }, fixture) => key === 'state_getMetadata' ? status : fixture });
  const first = await probe(503);
  const second = await probe(502);
  const metadata = verdict(first.report, 'net.rpc.state_probe', 'fail', 'http_5xx', 'upstream');
  assert.equal(metadata.message, 'state_getMetadata HTTP 503');
  assert.equal(metadata.evidence.http_status, 503);
  assert.deepEqual(first.report.summary, { pass: 10, warn: 0, fail: 1, unknown: 0 });
  assert.equal(first.report.fingerprint, second.report.fingerprint);
  assert.equal(first.exit, 2);
  const all = await run(['net'], { fetch: ({ rpc }, fixture) => rpc ? 503 : fixture });
  verdict(all.report, 'net.rpc.reachable', 'fail', 'http_5xx', 'upstream');
  verdict(all.report, 'net.rpc.syncing', 'unknown', 'src_http_5xx', 'upstream');
  verdict(all.report, 'net.rpc.finality', 'unknown', 'src_http_5xx', 'upstream');
  verdict(all.report, 'net.genesis.consistent', 'warn', 'partial', 'upstream');
  assert.equal(all.calls.fetch.some(({ key }) => key === 'chain_getHeader.finalized'), false);
});

test('08 redaction aliases and masks sensitive evidence before rendering and fingerprinting', async () => {
  const other = 'https://worker-two.example';
  const args = ['check', '--miner', `${MINERS[1]}=${ENDPOINT}`, '--miner', MINERS[2], '--miner', `${MINERS[0]}=${other}`];
  const options = { mutate: (fixtures) => { fixtures['/api/miners/'].strikes = 2; } };
  const raw = await run(args, options);
  const redacted = await run([...args, '--redact'], options);
  const text = await run([...args, '--redact', '--verbose'], options, false);
  for (const output of [redacted.text, text.text]) {
    for (const secret of [...MINERS, 'worker-one.example', 'worker-two.example', PUBLIC_IP, BALANCE, '8443']) assert.ok(!output.includes(secret));
  }
  const { report } = redacted;
  assert.deepEqual(validate(schema, report), []);
  assert.deepEqual(report.checks.filter(({ id }) => id === 'endpoint.dns').map(({ subject }) => subject), ['endpoint-1', 'endpoint-3']);
  assert.deepEqual(report.checks.filter(({ id }) => id === 'miner.active').map(({ subject }) => subject), ['miner-1', 'miner-2', 'miner-3']);
  assert.ok(report.sources.some(({ url }) => url === 'https://endpoint-1/session/info'));
  assert.ok(report.sources.some(({ url }) => url.endsWith('/api/accounts/miner-1')));
  const strike = row(report, 'miner.strikes', 'miner-1');
  assert.equal(strike.evidence.strikes, '[redacted]');
  assert.ok(strike.message.includes('[redacted]'));
  assert.equal(strike.fingerprint, sha('flop-doctor/v1\ndevnet\nminer.strikes\nminer-1\nwarn\noperator\nhas_strikes\n2'));
  assert.equal(row(report, 'miner.balance.fee').evidence.live_balance, true);
  assert.equal(row(report, 'miner.balance.fee').evidence.fail_threshold, '1000000000000000000');
  assert.equal(row(report, 'miner.calibration.expiry').evidence.head_source, 'rpc');
  assert.equal(row(report, 'miner.offer.published').evidence.truncated, false);
  assert.equal(row(report, 'endpoint.dns').evidence.addresses, '[redacted]');
  assert.deepEqual(row(report, 'market.model.has_offer'), row(raw.report, 'market.model.has_offer'));
  assert.notEqual(report.fingerprint, raw.report.fingerprint);
  assert.equal(report.fingerprint, (await run([...args, '--redact'], options)).report.fingerprint);
});

test('09 exit codes: priority matrix, usage errors, renderer errors and isolated checks', async () => {
  const statuses = ['pass', 'warn', 'unknown', 'fail'];
  const codes = [0, 1, 3, 2];
  for (const [leftIndex, left] of statuses.entries()) for (const [rightIndex, right] of statuses.entries()) {
    const result = aggregate([{ status: left }, { status: right }]);
    assert.equal(result.exit_code, codes[Math.max(leftIndex, rightIndex)]);
  }
  const args = [
    ['invalid-command'], ['net', '--missing'], ['miner', `${MINERS[0].slice(0, -1)}a`], ['miner', MINERS[0], MINERS[1]],
    ['net', '--rpc', 'http://example.test'], ['net', '--rpc', 'https://user:pass@example.test'], ['net', '--rpc', 'https://@example.test'],
    ['check', '--miner', `${MINERS[0]}=${ENDPOINT}`, '--endpoint', ENDPOINT], ['check', '--endpoint', ENDPOINT],
    ['check', '--miner', MINERS[0], '--miner', MINERS[1], '--endpoint', ENDPOINT],
    ['check', ...Array.from({ length: 9 }, () => ['--miner', MINERS[0]]).flat()], ['check', '--timeout', '4.9'],
    ['net', '--cert-warn-days', '3'], ['net', '--calib-warn-blocks', '-1'], ['net', '--expect-genesis', '0x1234'],
    ['miner', MINERS[0], '--endpoint', `${ENDPOINT}/path`], ['market', '--model='],
  ];
  for (const argv of args) {
    const invalid = await run(argv);
    assert.equal(invalid.exit, 64, argv.join(' '));
    assert.equal(invalid.report.schema, 'flop-doctor/error/v1');
    assert.equal(invalid.report.error.kind, 'usage');
    assert.equal(invalid.calls.fetch.length, 0);
    assert.equal(invalid.err.length, 1);
  }
  const crash = await run(['net'], { extra: { renderJson: () => { throw new Error('secret render detail'); } } });
  assert.equal(crash.exit, 70);
  assert.equal(crash.report.error.kind, 'internal');
  assert.ok(![crash.text, ...crash.err].join('\n').includes('secret render detail'));
  const isolated = [check('net.rpc.syncing', null, () => { throw new Error('private'); }), check('net.rpc.reachable', null, () => pass())];
  assert.equal(isolated[0].cause_class, 'internal');
  assert.equal(isolated[0].reason, 'check_crashed');
  assert.equal(isolated[1].status, 'pass');
  assert.equal(aggregate(isolated).exit_code, 3);
});

test('10 fingerprint ignores evidence/time/order and tracks exactly four fp_keys', async () => {
  const produce = (height, elapsed, balance, strikes) => {
    let timestamp = NOW;
    return run(['check', '--miner', MINERS[0]], {
      now: () => timestamp,
      fetch: (entry, fixture) => { timestamp += elapsed; return fixture; },
      mutate: (fixtures) => {
        fixtures.rpc.chain_getHeader = rpcResult({ number: hexHeight(height) });
        fixtures.rpc['chain_getHeader.finalized'] = rpcResult({ number: hexHeight(height - 3) });
        fixtures['/api/miners/'].calibration.expiresAtBlock = String(height + 1000);
        fixtures['/api/miners/'].strikes = strikes;
        fixtures['/api/accounts/'].balance = balance;
      },
    });
  };
  const first = (await produce(HEAD, 1, '1100000000000000000', 2)).report;
  const second = (await produce(HEAD + 1, 2, '1200000000000000000', 2)).report;
  assert.notEqual(first.duration_ms, second.duration_ms);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.fingerprint, reportFingerprint(first.network, first.checks.toReversed()));
  assert.equal(row(first, 'miner.balance.fee').fingerprint, row(second, 'miner.balance.fee').fingerprint);
  assert.notEqual(first.fingerprint, (await produce(HEAD, 1, '1100000000000000000', 3)).report.fingerprint);
  assert.notEqual(first.fingerprint, (await produce(HEAD, 1, '999999999999999999', 2)).report.fingerprint);
  const strike = { ...row(first, 'miner.strikes'), fp_key: 2 };
  assert.equal(strike.fingerprint, checkFingerprint('devnet', strike));
  for (const change of [{ status: 'fail' }, { reason: 'check_crashed' }, { cause_class: 'local' }, { fp_key: 3 }]) {
    assert.notEqual(strike.fingerprint, checkFingerprint('devnet', { ...strike, ...change }));
  }
  const changed = (count) => run(['miner', MINERS[0]], { mutate: (fixtures) => {
    fixtures['/api/miners/'].slashHistory = Array(count).fill({});
    fixtures['/api/miners/'].work.recentSessions = Array(count).fill({ status: 'timedout' });
    fixtures['/api/session-offers'].data[0].onChainFacts.reliability.disputesOpened = count;
  } });
  const [one, two] = (await Promise.all([changed(1), changed(2)])).map(({ report }) => report);
  for (const id of ['miner.slash', 'miner.channels.timedout', 'miner.reliability']) {
    assert.equal(row(one, id).reason, row(two, id).reason);
    assert.notEqual(row(one, id).fingerprint, row(two, id).fingerprint);
  }
});

test('11 budget bounds a noncooperative fetch, isolates completed work and aborts pending requests', async () => {
  const begin = performance.now();
  const options = {
    now: () => NOW + performance.now() - begin,
    fetch: ({ key }, fixture) => key === 'state_getMetadata' ? new Promise(() => {}) : fixture,
  };
  const [{ report, calls, exit }, perRequest] = await Promise.all([run(['net', '--timeout', '5'], options), run(['net', '--timeout', '20'], options)]);
  assert.ok(performance.now() - begin < 5500);
  assert.ok(report.duration_ms >= 4900);
  assert.equal(exit, 3);
  verdict(report, 'net.rpc.state_probe', 'unknown', 'budget_exhausted', 'budget');
  verdict(report, 'net.rpc.finality', 'pass', 'ok', 'none');
  assert.ok(calls.fetch.find(({ key }) => key === 'state_getMetadata').init.signal.aborted);
  assert.deepEqual(validate(schema, report), []);
  verdict(perRequest.report, 'net.rpc.state_probe', 'fail', 'timeout', 'upstream');
  assert.equal(perRequest.exit, 2);
});

test('12 local attribution needs at least three distinct failing upstream hosts', async () => {
  const all = await run(['net'], { fetch: ({ key }) => { throw mockError(key === 'system_health' ? 'ETIMEDOUT' : 'ENOTFOUND'); } });
  verdict(all.report, 'net.rpc.reachable', 'fail', 'timeout', 'local');
  verdict(all.report, 'net.explorer.index_lag', 'unknown', 'src_transport', 'local');
  verdict(all.report, 'net.faucet.reachable', 'warn', 'transport', 'local');
  verdict(all.report, 'net.genesis.consistent', 'unknown', 'insufficient_sources', 'local');
  assert.equal(row(all.report, 'net.explorer.index_lag').evidence.error_code, 'ENOTFOUND');
  assert.ok(!all.text.includes('private raw network error'));
  const one = await run(['net'], { fetch: ({ rpc }, fixture) => rpc ? mockError('ENOTFOUND') : fixture });
  verdict(one.report, 'net.rpc.state_probe', 'fail', 'transport', 'upstream');
  const same = await run(['net', '--rpc', 'https://same.example', '--explorer', 'https://same.example', '--gateway', 'https://same.example',
    '--faucet', 'https://same.example', '--releases', 'https://same.example/releases.json'], { fetch: () => mockError('ENOTFOUND') });
  verdict(same.report, 'net.rpc.reachable', 'fail', 'transport', 'upstream');
});

test('13 schema drift stays local to dependent checks; blank/malformed/oversized bodies are bounded', async () => {
  const { report } = await run(['check', '--miner', MINERS[0]], { mutate: (fixtures) => {
    delete fixtures['/api/health'].headLag;
    fixtures.rpc.system_health.result.isSyncing = 'false';
    fixtures['/api/miners/'].strikes = '0';
    fixtures['/api/accounts/'].balance = 1;
    fixtures['/limits'].sponsor.miner.automatic.max = '6';
    delete fixtures['/v1/models'].data[0]['x-flop'].price_sources;
    delete fixtures['/api/session-offers'].data[0].onChainFacts.reliability.ghost.incorrect;
  } });
  for (const id of ['net.explorer.index_lag', 'net.rpc.syncing', 'miner.strikes', 'miner.balance.fee', 'market.sponsor.slots', 'market.model.capacity', 'miner.reliability']) {
    verdict(report, id, 'unknown', 'src_schema', 'schema');
  }
  for (const id of ['net.explorer.reachable', 'net.rpc.reachable', 'miner.registered', 'market.model.has_offer', 'market.offers.present']) {
    verdict(report, id, 'pass', 'ok', 'none');
  }
  for (const response of [() => new Response(null, { status: 200 }), () => new Response('{'),
    () => new Response('{}'.padEnd(MAX_BODY + 1)), () => new Response('{}', { headers: { 'content-length': String(MAX_BODY + 1) } })]) {
    const broken = await run(['net'], { fetch: ({ key }, fixture) => key === 'state_getMetadata' ? response() : fixture });
    verdict(broken.report, 'net.rpc.state_probe', 'fail', 'bad_json', 'upstream');
    assert.equal(broken.calls.fetch.filter(({ key }) => key === 'state_getMetadata').length, 1);
  }
  const envelope = await run(['net'], { mutate: (fixtures) => { fixtures.rpc.state_getMetadata = { error: { code: 10, message: 'not exposed' } }; } });
  verdict(envelope.report, 'net.rpc.state_probe', 'fail', 'rpc_error');
  assert.ok(!envelope.text.includes('not exposed'));
});

test('14 multi-miner shares one page and release; 404 masks only that miner group', async () => {
  const { report, calls } = await run(['check', ...MINERS.flatMap((address) => ['--miner', address])], {
    fetch: ({ key }, fixture) => key === `/api/miners/${MINERS[1]}` ? 404 : fixture,
  });
  assert.equal(calls.fetch.filter(({ key }) => key === '/api/session-offers').length, 1);
  assert.equal(calls.fetch.filter(({ key }) => key === '/releases.json').length, 1);
  const affected = report.checks.filter(({ subject }) => subject === MINERS[1]);
  assert.equal(affected.length, 14);
  assert.ok(affected.every(({ id, status, reason }) => reason === 'not_registered' && status === (id === 'miner.registered' ? 'fail' : 'unknown')));
  assert.ok(report.checks.filter(({ subject }) => subject !== MINERS[1]).every(({ status }) => status === 'pass'));

  const repeated = await run(['check', '--miner', `${MINERS[0]}=${ENDPOINT}`, '--miner', `${MINERS[0]}=${ENDPOINT}`, '--redact']);
  assert.equal(repeated.calls.fetch.filter(({ key }) => key === `/api/miners/${MINERS[0]}`).length, 1);
  assert.equal(repeated.calls.httpsGet.length, 1);
  verdict(repeated.report, 'endpoint.session_info', 'pass', 'ok', 'none', 'endpoint-2');
});

test('net boundaries: lag, genesis and lightweight reachability', async () => {
  for (const [indexLag, finality, statuses] of [[20, 20, ['pass', 'pass']], [21, 21, ['warn', 'warn']], [200, 100, ['warn', 'warn']], [201, 101, ['fail', 'fail']]]) {
    const { report } = await run(['net'], { mutate: (fixtures) => {
      fixtures['/api/health'].headLag = indexLag;
      fixtures.rpc['chain_getHeader.finalized'].result.number = hexHeight(HEAD - finality);
    } });
    assert.equal(row(report, 'net.explorer.index_lag').status, statuses[0]);
    assert.equal(row(report, 'net.rpc.finality').status, statuses[1]);
  }
  const expected = `0x${'e4'.repeat(32)}`;
  const different = await run(['net', '--expect-genesis', expected]);
  verdict(different.report, 'net.genesis.consistent', 'fail', 'unexpected_genesis');
  const mismatch = await run(['net'], { mutate: (fixtures) => { fixtures['/chain'].genesisHash = expected; } });
  verdict(mismatch.report, 'net.genesis.consistent', 'fail', 'mismatch');
  const partial = await run(['net', '--expect-genesis', GENESIS.toUpperCase()], {
    fetch: ({ key }, fixture) => ['/chain', '/releases.json'].includes(key) ? 503 : fixture,
  });
  verdict(partial.report, 'net.genesis.consistent', 'warn', 'partial');
  for (const name of ['faucet', 'releases']) verdict(partial.report, `net.${name}.reachable`, 'warn', 'http_5xx');
});
