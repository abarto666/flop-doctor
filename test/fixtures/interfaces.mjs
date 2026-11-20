export const MINERS = [
  '5C62Ck4UrFPiBtoCmeSrgF7x9yv9mn38446dhCpsi2mLHiFT', '13dh9e6R4KNFrcSTZzidnuD2CpbwABXG6fEhzdTXEahwG9h',
  'vjdMToGeuZe87JkXpheYTyCiC7nN3hgKQGrJRMgN8Am95xKnX',
];
export const GENESIS = `0x${'ab'.repeat(32)}`;
export const FINALIZED_HASH = `0x${'3f'.repeat(32)}`;
export const MODEL_HASH = `0x${'a1'.repeat(32)}`;
export const OTHER_HASH = `0x${'c2'.repeat(32)}`;
export const HEAD = 4_200_000;
export const NOW = Date.parse('2026-11-20T08:00:00.000Z');
export const DAY = 86_400_000;
export const BALANCE = '12345678901234567890123456';
export const ENDPOINT = 'https://worker-one.example:8443';
export const PUBLIC_IP = '1.1.1.1';
export const certificate = (days) => ({ authorized: true, validTo: new Date(NOW + days * DAY).toISOString() });
export const hexHeight = (height) => `0x${height.toString(16)}`;
export const rpcResult = (result) => ({ jsonrpc: '2.0', id: 1, result });

export function offer(miner = MINERS[0], modelHash = MODEL_HASH) {
  return { offer: { miner, modelHash, expiry: '4258320' }, onChainFacts: {
    active: true, blacklisted: false,
    reliability: { settledCount: 12, timeoutCount: 0, forceOpenExpiredCount: 0, fraudUpheld: 0, disputesOpened: 0,
      ghost: { issued: 12, expired: 0, incorrect: 0 } },
  } };
}

export function model(id = 'qwen/qwen2.5-0.5b-instruct', hash = MODEL_HASH) {
  return { id, object: 'model', 'x-flop': { model_hash: hash, capacity_tpm: 494784, price_sources: [{ miner_address: MINERS[0] }] } };
}

export const healthy = {
  '/api/health': { connected: true, headLag: 1, writer: { genesis: GENESIS, indexedFinalizedHead: HEAD - 2 } },
  '/api/session-offers': { pagination: { total: MINERS.length, limit: 100 }, data: MINERS.map((miner) => offer(miner)) },
  '/api/miners/': {
    isActive: true, blacklisted: false, strikes: 0, slashHistory: [], totalSlashed: '0', selfStake: '200000000000000000000',
    sponsoredStake: '0', workerBuild: { version: '1.3.0' }, calibration: { prunable: false, capGflopsPerSec: '42.5',
      verifiedJobs: 16, expiresAtBlock: String(HEAD + 9200), observedAtBlock: String(HEAD - 1) },
    work: { recentSessions: [{ status: 'settled' }, { status: 'settled' }] }, recentChannels: [{ status: 'timedout' }],
    channels: [{ status: 'timedout' }],
  },
  '/api/accounts/': { balance: BALANCE, liveBalance: true },
  '/health': { connected: true, syncing: false, network: { observed_genesis_hash: GENESIS } },
  '/v1/models': { object: 'list', data: [model()] },
  '/chain': { genesisHash: GENESIS },
  '/limits': { faucet: { status: 'open', dailyCap: { remainingFlop: '3951044' } },
    sponsor: { miner: { automatic: { open: true, uncalibrated: 1, max: 6 } } } },
  '/releases.json': { cli: { latest: '1.3.0' }, 'miner-worker': { minimum: '1.1.0', latest: '1.3.0' }, models: { [MODEL_HASH]: {} } },
  rpc: {
    system_health: rpcResult({ peers: 24, isSyncing: false, shouldHavePeers: true }),
    chain_getBlockHash: rpcResult(GENESIS), chain_getFinalizedHead: rpcResult(FINALIZED_HASH),
    chain_getHeader: rpcResult({ number: hexHeight(HEAD) }), 'chain_getHeader.finalized': rpcResult({ number: hexHeight(HEAD - 3) }),
    state_getMetadata: rpcResult('0x6d6574610f0000'),
  },
};
