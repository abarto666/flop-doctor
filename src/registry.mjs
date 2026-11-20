import { FAILURES } from './config.mjs';

const sourceReasons = FAILURES.map((failure) => `src_${failure}`);
const common = ['ok', 'budget_exhausted', 'check_crashed'];
const metadata = ['http_status', 'elapsed_ms', 'error_code'];
const registry = {};

function add(group, id, cause_class, reasons, { source = sourceReasons, evidence = [] } = {}) {
  registry[`${group}.${id}`] = Object.freeze({
    group, cause_class, reasons: Object.freeze([...common, ...source, ...reasons]),
    sensitiveEvidenceKeys: Object.freeze(group === 'miner' || group === 'endpoint' ? [...metadata, ...evidence] : []),
  });
}

add('net', 'explorer.reachable', 'upstream', ['not_connected'], { source: FAILURES });
add('net', 'explorer.index_lag', 'upstream', ['lagging', 'stalled']);
add('net', 'rpc.reachable', 'upstream', [], { source: FAILURES });
add('net', 'rpc.syncing', 'upstream', ['syncing']);
add('net', 'rpc.finality', 'upstream', ['finality_lag', 'finality_stalled']);
add('net', 'rpc.state_probe', 'upstream', ['bad_metadata'], { source: FAILURES });
add('net', 'genesis.consistent', 'upstream', ['partial', 'mismatch', 'unexpected_genesis', 'insufficient_sources'], { source: [] });
add('net', 'gateway.reachable', 'upstream', ['not_connected'], { source: FAILURES });
add('net', 'gateway.syncing', 'upstream', ['syncing']);
add('net', 'faucet.reachable', 'upstream', [], { source: FAILURES });
add('net', 'releases.reachable', 'upstream', [], { source: FAILURES });

add('market', 'models.listed', 'market', ['empty_catalog']);
add('market', 'offers.present', 'market', ['no_valid_offers']);
add('market', 'catalog_offer_overlap', 'market', ['partial', 'disjoint_truncated', 'disjoint']);
add('market', 'model.has_offer', 'market', ['no_offer', 'no_offer_truncated', 'not_in_catalog']);
add('market', 'model.capacity', 'market', ['no_capacity']);
add('market', 'faucet.cap', 'upstream', ['cap_exhausted']);
add('market', 'sponsor.slots', 'upstream', ['closed', 'full']);

const miner = (id, reasons, evidence = []) => add('miner', id, 'operator', ['not_registered', ...reasons], { evidence });
miner('registered', []);
miner('active', ['inactive']);
miner('blacklist', ['blacklisted']);
miner('strikes', ['has_strikes'], ['strikes']);
miner('slash', ['slashed'], ['slash_count', 'total_slashed']);
miner('stake', ['no_stake'], ['self_stake', 'sponsored_stake']);
miner('worker_build', ['outdated', 'below_minimum', 'no_build_info'], ['version', 'latest_version', 'minimum_version']);
miner('calibration.state', ['no_calibration', 'prunable', 'no_capacity'], ['cap_gflops_per_sec', 'verified_jobs']);
miner('calibration.expiry', ['no_calibration', 'expiring', 'expired_or_imminent'], ['expires_at_block', 'head', 'remaining_blocks']);
miner('balance.fee', ['low', 'not_live', 'insufficient'], ['balance']);
miner('offer.published', ['no_offer', 'offer_invalid', 'offers_truncated'], ['offers', 'valid_offers', 'expiry']);
miner('offer.model_known', ['unknown_model'], ['model_hashes', 'unknown_model_hashes']);
miner('reliability', ['no_offer', 'incidents', 'fraud', 'ghost_failing', 'timeouts'],
  ['fraud_upheld', 'ghost_incorrect', 'ghost_expired', 'ghost_issued', 'settled_count', 'timeout_count', 'force_open_expired_count', 'disputes_opened']);
miner('channels.timedout', ['timedout', 'mostly_timedout'], ['timedout', 'channels']);

const endpoint = (id, reasons, evidence = []) => add('endpoint', id, 'operator', reasons, { source: [], evidence });
endpoint('dns', ['ip_literal', 'tailscale_domain', 'no_records', 'private_address', 'resolver_error', 'fake_ip_suspected'], ['addresses']);
endpoint('tls', ['skipped_dns', 'expiring', 'expired_or_imminent', 'untrusted', 'handshake_failed'], ['valid_to', 'days_remaining']);
endpoint('session_info', ['skipped_dns', 'redirect', 'unauthenticated_access', 'unexpected_status', 'unreachable']);

export const REGISTRY = Object.freeze(registry);
