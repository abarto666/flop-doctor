import { positive } from '../config.mjs';
import { evidenceFor, field } from '../http.mjs';
import { REGISTRY } from '../registry.mjs';
import { check, fail, pass, sourceFailure, unknown, warn, when } from '../result.mjs';
import { compareSemver, parseSemver } from '../util/semver.mjs';
import { validOffer } from './market.mjs';

function build(miner, releases) {
  return when(field(miner, 'workerBuild'), (buildInfo) => {
    const version = buildInfo?.version;
    if (!parseSemver(version)) return unknown('no_build_info', version === undefined ? {} : { version });
    return when(field(releases, 'worker'), ({ latest, minimum }) => {
      const evidence = { version, latest_version: latest, minimum_version: minimum };
      return compareSemver(version, minimum) < 0 ? fail('below_minimum', evidence) :
        compareSemver(version, latest) < 0 ? warn('outdated', evidence) : pass(evidence);
    });
  });
}

function calibrationState(calibration) {
  if (!calibration) return fail('no_calibration');
  const { prunable, capGflopsPerSec, verifiedJobs } = calibration;
  const evidence = { prunable, cap_gflops_per_sec: capGflopsPerSec, verified_jobs: verifiedJobs };
  return prunable ? fail('prunable', evidence) : !positive(capGflopsPerSec) || !verifiedJobs ? warn('no_capacity', evidence) : pass(evidence);
}

function calibrationExpiry(miner, head, config) {
  return when(field(miner, 'calibrationExpiry'), (calibration) => {
    if (!calibration) return unknown('no_calibration');
    const observed = field(miner, 'observedHead');
    if (!head.ok && !observed.ok) return sourceFailure(head.failure === 'budget_exhausted' ? head : observed);
    const height = head.ok ? head.data : observed.data.observedAtBlock;
    const remaining = BigInt(calibration.expiresAtBlock) - BigInt(height);
    const warnThreshold = config['calib-warn-blocks'];
    const failThreshold = config['calib-fail-blocks'];
    const evidence = { expires_at_block: calibration.expiresAtBlock, head: height, head_source: head.ok ? 'rpc' : 'observed',
      remaining_blocks: remaining.toString(), warn_threshold: warnThreshold, fail_threshold: failThreshold };
    return remaining <= BigInt(failThreshold) ? fail('expired_or_imminent', evidence) :
      remaining <= BigInt(warnThreshold) ? warn('expiring', evidence) : pass(evidence);
  });
}

function offerPublished(rows, truncated) {
  const valid = rows.filter(validOffer).length;
  const evidence = { offers: rows.length, valid_offers: valid, expiry: rows.map((row) => row.expiry), truncated };
  return valid ? pass(evidence) : rows.length ? fail('offer_invalid', evidence) :
    truncated ? unknown('offers_truncated', evidence) : warn('no_offer', evidence);
}

function reliability({ settledCount, timeoutCount, forceOpenExpiredCount, disputesOpened, fraudUpheld, ghost }) {
  const evidence = { fraud_upheld: fraudUpheld, ghost_incorrect: ghost.incorrect, ghost_expired: ghost.expired, ghost_issued: ghost.issued,
    settled_count: settledCount, timeout_count: timeoutCount, force_open_expired_count: forceOpenExpiredCount, disputes_opened: disputesOpened };
  const incidents = [ghost.incorrect, ghost.expired, timeoutCount, forceOpenExpiredCount, disputesOpened];
  const extras = { fp_key: [fraudUpheld, ...incidents].join(':') };
  const jobs = BigInt(settledCount) + BigInt(timeoutCount);
  if (fraudUpheld > 0) return fail('fraud', evidence, extras);
  if (ghost.issued >= 10 && (BigInt(ghost.expired) + BigInt(ghost.incorrect)) * 10n > BigInt(ghost.issued)) return fail('ghost_failing', evidence, extras);
  if (jobs >= 10n && BigInt(timeoutCount) * 5n > jobs) return fail('timeouts', evidence, extras);
  return incidents.some(Boolean) ? warn('incidents', evidence, extras) : pass(evidence, extras);
}

export function checkMiner(sources, config, subject) {
  const run = (id, evaluate) => check(`miner.${id}`, subject, evaluate);
  const { miner, account, releases, head, offers } = sources;
  const registered = run('registered', () => miner.http_status === 200 ? pass(evidenceFor(miner)) :
    miner.http_status === 404 ? fail('not_registered', evidenceFor(miner)) : sourceFailure(miner));
  if (registered.status === 'fail') return [registered, ...Object.keys(REGISTRY).filter((id) => id.startsWith('miner.') && id !== registered.id)
    .map((id) => check(id, subject, () => unknown('not_registered')))];
  const withMiner = (name, key, evaluate) => run(name, () => when(field(miner, key), evaluate));
  const withOffers = (name, evaluate) => run(name, () => when(offers, ({ rows, truncated }) =>
    evaluate(rows.filter((offer) => offer.miner === subject), truncated)));
  return [registered,
    withMiner('active', 'isActive', (isActive) => isActive ? pass({ is_active: isActive }) : fail('inactive', { is_active: isActive })),
    withMiner('blacklist', 'blacklisted', (blacklisted) => blacklisted ? fail('blacklisted', { blacklisted }) : pass({ blacklisted })),
    withMiner('strikes', 'strikes', (strikes) => strikes ? warn('has_strikes', { strikes }, { fp_key: strikes }) : pass({ strikes }, { fp_key: 0 })),
    withMiner('slash', 'slash', ({ history, total }) => {
      const evidence = { slash_count: history.length, total_slashed: total };
      const extras = { fp_key: history.length };
      return history.length || BigInt(total) ? warn('slashed', evidence, extras) : pass(evidence, extras);
    }),
    withMiner('stake', 'stake', ({ self, sponsored }) => {
      const evidence = { self_stake: self, sponsored_stake: sponsored };
      return BigInt(self) + BigInt(sponsored) > 0n ? pass(evidence) : fail('no_stake', evidence);
    }),
    run('worker_build', () => build(miner, releases)),
    withMiner('calibration.state', 'calibrationState', calibrationState),
    run('calibration.expiry', () => calibrationExpiry(miner, head, config)),
    run('balance.fee', () => when(account, ({ balance, liveBalance }) => {
      const minimum = config.minFee;
      const value = BigInt(balance);
      const evidence = { balance, live_balance: liveBalance, fail_threshold: minimum.toString(), warn_threshold: (2n * minimum).toString() };
      return value < minimum ? fail('insufficient', evidence) : value < 2n * minimum ? warn('low', evidence) :
        !liveBalance ? warn('not_live', evidence) : pass(evidence);
    })),
    withOffers('offer.published', offerPublished),
    withOffers('offer.model_known', (rows) => {
      const model_hashes = rows.map((offer) => offer.modelHash);
      if (!rows.length) return pass({ model_hashes });
      return when(field(releases, 'models'), (models) => {
        const known = new Set(Object.keys(models).map((key) => key.toLowerCase()));
        const unknown_model_hashes = model_hashes.filter((hash) => !known.has(hash.toLowerCase()));
        return unknown_model_hashes.length ? warn('unknown_model', { model_hashes, unknown_model_hashes }) : pass({ model_hashes });
      });
    }),
    withOffers('reliability', (rows) => rows.length ? when(rows[0].reliability, reliability) : unknown('no_offer')),
    withMiner('channels.timedout', 'channels', (rows) => {
      const timedout = rows.filter(({ status }) => status === 'timedout').length;
      const evidence = { timedout, channels: rows.length };
      const extras = { fp_key: timedout };
      return rows.length >= 4 && timedout * 2 > rows.length ? fail('mostly_timedout', evidence, extras) :
        timedout ? warn('timedout', evidence, extras) : pass(evidence, extras);
    }),
  ];
}
