import { amount, block, bool, count, hash, modelHash, object, OFFER_LIMIT, quantity, string } from '../config.mjs';
import { apiUrl, fields, requestJson, select } from '../http.mjs';

const get = (deps, id, path) => requestJson(deps, `explorer.${id}`, apiUrl(deps.config.explorer, path));
const metrics = (value) => object(value) && [value.settledCount, value.timeoutCount, value.forceOpenExpiredCount,
  value.disputesOpened, value.fraudUpheld, value.ghost?.issued, value.ghost?.expired, value.ghost?.incorrect].every(count);

export async function fetchExplorerHealth(deps) {
  return fields(await get(deps, 'health', '/api/health'), {
    connected: [(body) => body.connected, bool],
    headLag: [(body) => body.headLag, count],
    genesis: [(body) => body.writer?.genesis, hash],
  });
}

export async function fetchOffers(deps) {
  const source = await get(deps, 'session_offers', `/api/session-offers?limit=${OFFER_LIMIT}`);
  const body = source.data;
  if (!source.ok) return source;
  const rows = body?.data;
  if (!Array.isArray(rows) || !count(body.pagination?.total) || !rows.every((row) =>
    string(row?.offer?.miner) && modelHash(row?.offer?.modelHash) && amount(row?.offer?.expiry) &&
    bool(row?.onChainFacts?.active) && bool(row?.onChainFacts?.blacklisted))) return select(source, false);
  return { ...source, data: { truncated: body.pagination.total > rows.length, rows: rows.map(({ offer, onChainFacts }) => ({
    miner: offer.miner, modelHash: offer.modelHash, expiry: offer.expiry,
    active: onChainFacts.active, blacklisted: onChainFacts.blacklisted,
    reliability: select(source, metrics(onChainFacts.reliability), onChainFacts.reliability),
  })) } };
}

export async function fetchMiner(deps, address) {
  return fields(await get(deps, 'miner', `/api/miners/${address}`), {
    isActive: [(body) => body.isActive, bool],
    blacklisted: [(body) => body.blacklisted, bool],
    strikes: [(body) => body.strikes, count],
    slash: [(body) => ({ history: body.slashHistory, total: body.totalSlashed }),
      (value) => Array.isArray(value.history) && amount(value.total)],
    stake: [(body) => ({ self: body.selfStake, sponsored: body.sponsoredStake }),
      (value) => amount(value.self) && amount(value.sponsored)],
    workerBuild: [(body) => body.workerBuild, (value) => value === null || (object(value) && typeof value.version === 'string')],
    calibrationState: [(body) => body.calibration, (value) => value === null || (object(value) &&
      bool(value.prunable) && quantity(value.capGflopsPerSec) && count(value.verifiedJobs))],
    calibrationExpiry: [(body) => body.calibration, (value) => value === null || (object(value) && block(value.expiresAtBlock))],
    observedHead: [(body) => body.calibration, (value) => value === null || (object(value) && block(value.observedAtBlock))],
    channels: [(body) => body.work?.recentSessions ?? body.recentChannels ?? body.channels,
      (value) => Array.isArray(value) && value.every((row) => string(row?.status))],
  });
}

export async function fetchAccount(deps, address) {
  const source = await get(deps, 'account', `/api/accounts/${address}`);
  return select(source, amount(source.data?.balance) && bool(source.data?.liveBalance), source.data);
}
