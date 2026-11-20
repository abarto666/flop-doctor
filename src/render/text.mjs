import { STATUS_ORDER } from '../config.mjs';
import { byIdSubject } from '../result.mjs';

const PROBES = {
  'net.rpc.state_probe': 'state_getMetadata', 'net.rpc.reachable': 'system_health',
  'net.explorer.reachable': 'Explorer /api/health', 'net.gateway.reachable': 'Gateway /health',
  'net.faucet.reachable': 'Faucet /chain', 'net.releases.reachable': 'Releases manifest',
  'endpoint.session_info': '/session/info',
};
const MESSAGES = {
  ok: 'Check passed', budget_exhausted: 'Global time budget exhausted', check_crashed: 'Check raised an internal error',
  not_connected: 'Upstream is not connected', syncing: 'Upstream is syncing', bad_metadata: 'Metadata magic prefix is invalid',
  mismatch: 'Observed genesis hashes differ', unexpected_genesis: 'Observed genesis does not match the expected hash',
  insufficient_sources: 'Fewer than two genesis sources available', empty_catalog: 'Gateway model catalog is empty',
  no_valid_offers: '0 valid offers', no_offer: '0 valid offers', no_offer_truncated: '0 valid offers on the first page',
  disjoint: 'No catalog model has a valid offer', disjoint_truncated: 'No catalog model has a valid offer on the first page',
  not_in_catalog: 'Selected model is not in the catalog', no_capacity: 'Capacity or supporting work is missing',
  cap_exhausted: 'Faucet daily cap exhausted', closed: 'Automatic miner sponsorship is closed', full: 'Automatic miner sponsorship slots are full',
  not_registered: 'Miner is not registered', inactive: 'Miner is inactive', blacklisted: 'Miner is blacklisted',
  no_stake: 'Miner has no stake', no_build_info: 'No valid worker build version', outdated: 'Worker build is older than latest',
  below_minimum: 'Worker build is below minimum', no_calibration: 'No calibration available', prunable: 'Calibration is prunable',
  low: 'Fee balance is below the warning threshold', not_live: 'Fee balance is not live', insufficient: 'Fee balance is below the minimum',
  offer_invalid: 'Published offers are not active and unblacklisted', offers_truncated: 'Miner has no offer on the first page',
  unknown_model: 'Published offer references an unknown model', incidents: 'Reliability incidents observed', fraud: 'Fraud dispute upheld',
  ghost_failing: 'Ghost job failure rate exceeds 10%', timeouts: 'Job timeout rate exceeds 20%',
  ip_literal: 'Endpoint must use a DNS hostname', tailscale_domain: 'Tailscale hostnames are not public endpoints',
  no_records: 'No DNS address records', private_address: 'DNS returned a non-public address',
  resolver_error: 'DNS resolution did not complete reliably', fake_ip_suspected: 'DNS returned an address in the proxy fake-IP range',
  skipped_dns: 'Connection skipped because DNS did not pass', untrusted: 'TLS peer certificate or hostname is not trusted',
  handshake_failed: 'TLS handshake failed', redirect: 'Anonymous session probe returned a redirect',
  unauthenticated_access: 'Anonymous /session/info unexpectedly returned HTTP 200',
  unexpected_status: 'Anonymous session probe did not return HTTP 401', unreachable: 'Could not connect to /session/info',
};

export function messageFor({ id, reason, evidence }) {
  if (reason === 'partial') return id === 'net.genesis.consistent' ? 'Available genesis hashes match; some sources are missing' :
    `${evidence.matched} of ${evidence.models} catalog models have a valid offer`;
  if (['lagging', 'stalled', 'finality_lag', 'finality_stalled'].includes(reason)) return `Lag: ${evidence.head_lag ?? evidence.lag} blocks`;
  if (['has_strikes', 'slashed', 'timedout', 'mostly_timedout'].includes(reason)) {
    const value = evidence.strikes ?? evidence.slash_count ?? evidence.timedout;
    return `${reason.replaceAll('_', ' ')}: ${value}`;
  }
  if (reason === 'expiring' || reason === 'expired_or_imminent') {
    return `${reason.replaceAll('_', ' ')}: ${evidence.days_remaining ?? evidence.remaining_blocks} ${id === 'endpoint.tls' ? 'days' : 'blocks'} remaining`;
  }
  if (PROBES[id] && reason.startsWith('http_')) return `${PROBES[id]} HTTP ${evidence.http_status}`;
  if (reason.startsWith('src_')) return evidence.http_status !== undefined && reason.startsWith('src_http_') ?
    `Upstream HTTP ${evidence.http_status}` : `Upstream source: ${reason.slice(4)}`;
  return MESSAGES[reason] ?? `Probe failed: ${reason}`;
}

const terminalSafe = (value) => String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
  (char) => `\\u{${char.codePointAt(0).toString(16)}}`);

export function renderText(report, verbose = false) {
  const { status, summary, fingerprint } = report;
  const lines = [`FLOP-DOCTOR ${status.toUpperCase()} fail=${summary.fail} warn=${summary.warn} unknown=${summary.unknown} pass=${summary.pass} fp=${fingerprint}`];
  const checks = report.checks.filter((row) => verbose || row.status !== 'pass').sort((left, right) =>
    STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status) || byIdSubject(left, right));
  for (const row of checks) {
    const subject = row.subject === null ? '' : `{${terminalSafe(row.subject)}}`;
    lines.push(`${row.status.toUpperCase()} ${row.id}${subject} [${row.cause_class}] ${row.reason}: ${terminalSafe(row.message)}`);
  }
  return lines.join('\n');
}
