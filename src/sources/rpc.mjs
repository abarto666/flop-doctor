import { bool, hash, object } from '../config.mjs';
import { fields, invalid, requestJson, select } from '../http.mjs';

async function rpc(deps, method, params = [], tag = method) {
  const source = await requestJson(deps, `rpc.${tag}`, deps.config.rpc, { rpc: { jsonrpc: '2.0', id: 1, method, params } });
  if (!source.ok) return source;
  const envelope = source.data;
  if (!object(envelope)) return invalid(source);
  if (Object.hasOwn(envelope, 'error')) return { ...source, ok: false, data: undefined, failure: 'rpc_error' };
  return select(source, Object.hasOwn(envelope, 'result'), envelope.result);
}

export async function fetchRpcHealth(deps) {
  const source = await rpc(deps, 'system_health');
  if (!source.ok) return source;
  return fields({ ...source, data: { result: source.data } }, {
    reachable: [(body) => body.result, () => true],
    syncing: [(body) => body.result?.isSyncing, bool],
  });
}

export async function fetchRpcGenesis(deps) {
  const source = await rpc(deps, 'chain_getBlockHash', [0]);
  return select(source, hash(source.data), source.data);
}

export async function fetchRpcFinalizedHead(deps) {
  const source = await rpc(deps, 'chain_getFinalizedHead');
  return select(source, hash(source.data), source.data);
}

export async function fetchRpcHeader(deps, finalizedHash) {
  const source = await rpc(deps, 'chain_getHeader', finalizedHash ? [finalizedHash] : [],
    finalizedHash ? 'chain_getHeader.finalized' : 'chain_getHeader');
  const number = source.data?.number;
  return select(source, typeof number === 'string' && /^0x[0-9a-f]+$/i.test(number), number);
}

export async function fetchRpcMetadata(deps) {
  const source = await rpc(deps, 'state_getMetadata');
  return select(source, typeof source.data === 'string', source.data);
}
