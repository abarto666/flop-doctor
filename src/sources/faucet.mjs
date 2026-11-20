import { bool, count, hash, quantity } from '../config.mjs';
import { apiUrl, fields, requestJson } from '../http.mjs';

const get = (deps, id, path) => requestJson(deps, `faucet.${id}`, apiUrl(deps.config.faucet, path));

export async function fetchFaucetChain(deps) {
  return fields(await get(deps, 'chain', '/chain'), {
    reachable: [(body) => body.genesisHash, (value) => typeof value === 'string'],
    genesis: [(body) => body.genesisHash, hash],
  });
}

export async function fetchFaucetLimits(deps) {
  return fields(await get(deps, 'limits', '/limits'), {
    cap: [(body) => body.faucet?.dailyCap?.remainingFlop, quantity],
    sponsor: [(body) => body.sponsor?.miner?.automatic,
      (value) => bool(value?.open) && count(value?.uncalibrated) && count(value?.max)],
  });
}
