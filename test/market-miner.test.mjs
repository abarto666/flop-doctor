import assert from 'node:assert/strict';
import test from 'node:test';
import { HEAD, MINERS, MODEL_HASH, OTHER_HASH, model } from './fixtures/interfaces.mjs';
import { row, run, verdict } from './helpers/mock-deps.mjs';

const primary = model().id;
const secondary = 'example/another';
const miner = (options, extra = []) => run(['miner', MINERS[0], ...extra], options);

test('03 market matching, selection, truncation and valid-offer filtering', async () => {
  const disjoint = (fixtures) => { fixtures['/v1/models'].data = [model(secondary, OTHER_HASH)]; };
  const result = await run(['market'], { mutate: disjoint });
  verdict(result.report, 'market.catalog_offer_overlap', 'fail', 'disjoint', 'market');
  verdict(result.report, 'market.model.has_offer', 'warn', 'no_offer', 'market', secondary);
  const selected = await run(['market', '--model', secondary.toUpperCase()], { mutate: disjoint });
  verdict(selected.report, 'market.model.has_offer', 'fail', 'no_offer', 'market', secondary);
  const partial = await run(['market'], { mutate: (fixtures) => fixtures['/v1/models'].data.push(model(secondary, OTHER_HASH)) });
  verdict(partial.report, 'market.catalog_offer_overlap', 'warn', 'partial', 'market');
  verdict(partial.report, 'market.model.has_offer', 'pass', 'ok', 'none', primary);
  const truncated = await run(['market', '--model', OTHER_HASH.toUpperCase()], { mutate: (fixtures) => {
    disjoint(fixtures);
    fixtures['/api/session-offers'].pagination.total = 101;
  } });
  verdict(truncated.report, 'market.catalog_offer_overlap', 'warn', 'disjoint_truncated');
  const truncatedModel = verdict(truncated.report, 'market.model.has_offer', 'warn', 'no_offer_truncated', 'market', secondary);
  assert.equal(truncatedModel.evidence.truncated, true);
  const missing = await run(['market', '--model', 'missing', '--model', MODEL_HASH.toUpperCase()]);
  verdict(missing.report, 'market.model.has_offer', 'fail', 'not_in_catalog', 'market', 'missing');
  verdict(missing.report, 'market.model.has_offer', 'pass', 'ok', 'none', primary);
  const invalid = await run(['market'], { mutate: (fixtures) => {
    for (const [index, { onChainFacts }] of fixtures['/api/session-offers'].data.entries()) {
      if (index % 2) onChainFacts.active = false;
      else onChainFacts.blacklisted = true;
    }
  } });
  verdict(invalid.report, 'market.offers.present', 'fail', 'no_valid_offers', 'market');
  assert.deepEqual(row(result.report, 'market.offers.present').evidence.expiry, Array(3).fill('4258320'));
});

test('04 calibration expiry boundaries, thresholds, state and observed fallback', async () => {
  const cases = [[7201, 'pass', 'ok'], [7200, 'warn', 'expiring'], [601, 'warn', 'expiring'],
    [600, 'fail', 'expired_or_imminent'], [-1, 'fail', 'expired_or_imminent']];
  const expiry = (remaining, patch = {}) => ({ mutate: (fixtures) => Object.assign(fixtures['/api/miners/'].calibration,
    { expiresAtBlock: String(HEAD + remaining), ...patch }) });
  for (const [remaining, status, reason] of cases) {
    const { report } = await miner(expiry(remaining));
    const check = verdict(report, 'miner.calibration.expiry', status, reason);
    assert.equal(check.evidence.remaining_blocks, String(remaining));
    assert.equal(check.evidence.head_source, 'rpc');
  }
  const custom = await miner(expiry(10), ['--calib-warn-blocks', '10', '--calib-fail-blocks', '2']);
  verdict(custom.report, 'miner.calibration.expiry', 'warn', 'expiring');
  const customFail = await miner(expiry(2), ['--calib-warn-blocks', '10', '--calib-fail-blocks', '2']);
  verdict(customFail.report, 'miner.calibration.expiry', 'fail', 'expired_or_imminent');
  const absent = await miner({ mutate: (fixtures) => { fixtures['/api/miners/'].calibration = null; } });
  verdict(absent.report, 'miner.calibration.expiry', 'unknown', 'no_calibration');
  verdict(absent.report, 'miner.calibration.state', 'fail', 'no_calibration');
  const prunable = await miner(expiry(9999, { prunable: true }));
  verdict(prunable.report, 'miner.calibration.state', 'fail', 'prunable');
  const cap = await miner(expiry(9999, { capGflopsPerSec: '0.00' }));
  verdict(cap.report, 'miner.calibration.state', 'warn', 'no_capacity');
  const observed = await miner({ ...expiry(600), fetch: ({ key }, fixture) => key === 'chain_getHeader' ? 503 : fixture });
  const fallback = verdict(observed.report, 'miner.calibration.expiry', 'warn', 'expiring');
  assert.equal(fallback.evidence.head_source, 'observed');
  assert.equal(fallback.evidence.remaining_blocks, '601');
});

test('05 fee thresholds are exact in planck, including one-unit and huge-integer differences', async () => {
  const balance = (value, live = true) => ({ mutate: (fixtures) => { fixtures['/api/accounts/'] = { balance: value, liveBalance: live }; } });
  for (const [value, live, status, reason] of [
    ['999999999999999999', true, 'fail', 'insufficient'], ['1000000000000000000', true, 'warn', 'low'],
    ['1999999999999999999', true, 'warn', 'low'], ['2000000000000000000', true, 'pass', 'ok'],
    ['2000000000000000000', false, 'warn', 'not_live'], ['1000000000000000000', false, 'warn', 'low'],
  ]) {
    const { report } = await miner(balance(value, live));
    assert.equal(verdict(report, 'miner.balance.fee', status, reason).evidence.balance, value);
  }
  const huge = await miner(balance('1234567890123456789012345678901234567890'), ['--min-fee-flop', '1234567890123456789012.345678901234567891']);
  verdict(huge.report, 'miner.balance.fee', 'fail', 'insufficient');
  const half = await miner(balance('1000000000000000000'), ['--min-fee-flop', '0.5']);
  verdict(half.report, 'miner.balance.fee', 'pass', 'ok');
  for (const value of ['0.1234567890123456789', '1e1', '-1', 'NaN']) {
    const invalid = await miner({}, ['--min-fee-flop', value]);
    assert.equal(invalid.exit, 64);
    assert.equal(invalid.calls.fetch.length, 0);
  }
});

test('miner channel precedence and strict timeout fraction boundaries', async () => {
  const scenarios = [
    [{ work: { recentSessions: [] }, recentChannels: [{ status: 'timedout' }] }, 'pass', 'ok', 0],
    [{ work: { recentSessions: null }, recentChannels: [{ status: 'timedout' }] }, 'warn', 'timedout', 1],
    [{ work: null, recentChannels: null, channels: [{ status: 'timedout' }] }, 'warn', 'timedout', 1],
    [{ work: { recentSessions: ['timedout', 'timedout', 'timedout', 'settled'].map((status) => ({ status })) } }, 'fail', 'mostly_timedout', 3],
    [{ work: { recentSessions: ['timedout', 'timedout', 'settled', 'settled'].map((status) => ({ status })) } }, 'warn', 'timedout', 2],
  ];
  for (const [profile, status, reason, count] of scenarios) {
    const { report } = await miner({ mutate: (fixtures) => Object.assign(fixtures['/api/miners/'], profile) });
    assert.equal(verdict(report, 'miner.channels.timedout', status, reason).evidence.timedout, count);
  }
});

test('remaining miner checks: workers, registration, offer ambiguity and reliability thresholds', async () => {
  for (const [version, status, reason] of [['1.3.1', 'pass', 'ok'], ['1.1.0', 'warn', 'outdated'],
    ['1.1.0-rc.1', 'fail', 'below_minimum'], ['not-semver', 'unknown', 'no_build_info'], [null, 'unknown', 'no_build_info']]) {
    const { report } = await miner({ mutate: (fixtures) => { fixtures['/api/miners/'].workerBuild = version === null ? null : { version }; } });
    verdict(report, 'miner.worker_build', status, reason);
  }
  const profile = await miner({ mutate: (fixtures) => Object.assign(fixtures['/api/miners/'], { isActive: false, blacklisted: true, selfStake: '0' }) });
  for (const [id, reason] of [['active', 'inactive'], ['blacklist', 'blacklisted'], ['stake', 'no_stake']]) verdict(profile.report, `miner.${id}`, 'fail', reason);
  for (const [total, status, reason] of [[0, 'warn', 'no_offer'], [101, 'unknown', 'offers_truncated']]) {
    const { report } = await miner({ mutate: (fixtures) => { fixtures['/api/session-offers'] = { data: [], pagination: { total } }; } });
    verdict(report, 'miner.offer.published', status, reason);
    verdict(report, 'miner.reliability', 'unknown', 'no_offer');
  }
  const invalid = await miner({ mutate: (fixtures) => {
    const [first] = fixtures['/api/session-offers'].data;
    first.onChainFacts.active = false;
    first.offer.modelHash = OTHER_HASH;
  } });
  verdict(invalid.report, 'miner.offer.published', 'fail', 'offer_invalid');
  verdict(invalid.report, 'miner.offer.model_known', 'warn', 'unknown_model');
  const cases = [
    [{ fraudUpheld: 1 }, 'fail', 'fraud'], [{ ghost: { issued: 10, expired: 1, incorrect: 0 } }, 'warn', 'incidents'],
    [{ ghost: { issued: 10, expired: 1, incorrect: 1 } }, 'fail', 'ghost_failing'], [{ settledCount: 8, timeoutCount: 2 }, 'warn', 'incidents'],
    [{ settledCount: 7, timeoutCount: 3 }, 'fail', 'timeouts'], [{ settledCount: 1, timeoutCount: 3 }, 'warn', 'incidents'],
  ];
  for (const [metrics, status, reason] of cases) {
    const { report } = await miner({ mutate: (fixtures) => Object.assign(fixtures['/api/session-offers'].data[0].onChainFacts.reliability, metrics) });
    verdict(report, 'miner.reliability', status, reason);
  }
});

test('remaining market checks: empty catalog, capacity and sponsor/faucet boundaries', async () => {
  const changed = (fixtures) => {
    fixtures['/limits'].faucet.dailyCap.remainingFlop = '0';
    fixtures['/limits'].sponsor.miner.automatic.uncalibrated = 6;
    fixtures['/v1/models'].data[0]['x-flop'].capacity_tpm = 0;
  };
  const automatic = await run(['market'], { mutate: changed });
  verdict(automatic.report, 'market.faucet.cap', 'warn', 'cap_exhausted', 'upstream');
  verdict(automatic.report, 'market.sponsor.slots', 'warn', 'full', 'upstream');
  verdict(automatic.report, 'market.model.capacity', 'warn', 'no_capacity', 'market', primary);
  const selected = await run(['market', '--model', primary], { mutate: changed });
  verdict(selected.report, 'market.model.capacity', 'fail', 'no_capacity', 'market', primary);
  const empty = await run(['market'], { mutate: (fixtures) => {
    fixtures['/v1/models'].data = [];
    fixtures['/limits'].sponsor.miner.automatic.open = false;
  } });
  verdict(empty.report, 'market.models.listed', 'fail', 'empty_catalog');
  verdict(empty.report, 'market.sponsor.slots', 'warn', 'closed');
});
