import { bool, hash, modelHash, quantity, string } from '../config.mjs';
import { apiUrl, fields, requestJson, select } from '../http.mjs';

const get = (deps, id, path) => requestJson(deps, `gateway.${id}`, apiUrl(deps.config.gateway, path));

export async function fetchGatewayHealth(deps) {
  return fields(await get(deps, 'health', '/health'), {
    connected: [(body) => body.connected, bool],
    syncing: [(body) => body.syncing, bool],
    genesis: [(body) => body.network?.observed_genesis_hash, hash],
  });
}

export async function fetchModels(deps) {
  const source = await get(deps, 'models', '/v1/models');
  const rows = source.data?.data;
  if (!source.ok || !Array.isArray(rows)) return select(source, false);
  const normalized = rows.map((row) => {
    const facts = row?.['x-flop'];
    return {
      id: string(row?.id) ? row.id : null,
      hash: select(source, modelHash(facts?.model_hash), facts?.model_hash),
      capacity: select(source, quantity(facts?.capacity_tpm) && Array.isArray(facts?.price_sources),
        { capacity_tpm: facts?.capacity_tpm, price_sources: facts?.price_sources?.length }),
    };
  });
  return fields({ ...source, data: { data: normalized } }, {
    listed: [(body) => body.data, Array.isArray],
    catalog: [(body) => body.data, (models) => models.every((model) => model.id !== null && model.hash.ok)],
    capacity: [(body) => body.data, (models) => models.every((model) => model.capacity.ok)],
  });
}
