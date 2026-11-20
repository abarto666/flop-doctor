import { evidenceFor, field } from '../http.mjs';
import { check, fail, pass, sourceFailure, unavailable, unknown, warn, when } from '../result.mjs';

function connected(source) {
  return !source.ok ? sourceFailure(source, 'fail') : source.data ? pass({ connected: true }) : fail('not_connected', { connected: false });
}

function syncing(source) {
  return when(source, (value) => value ? warn('syncing', { syncing: value }) : pass({ syncing: value }));
}

function genesis(sources, expected) {
  const inputs = { rpc: sources.genesis, faucet: field(sources.chain, 'genesis'), gateway: field(sources.gateway, 'genesis'),
    explorer: field(sources.explorer, 'genesis') };
  const evidence = Object.fromEntries(Object.entries(inputs).filter(([, source]) => source.ok).map(([name, source]) => [name, source.data]));
  if (expected) evidence.expected = expected;
  const observed = Object.values(inputs).filter((source) => source.ok).map((source) => source.data.toLowerCase());
  if (new Set(observed).size > 1) return fail('mismatch', evidence);
  if (expected && observed.some((value) => value !== expected.toLowerCase())) return fail('unexpected_genesis', evidence);
  const pending = Object.values(inputs).find((source) => source.failure === 'budget_exhausted');
  if (pending) return sourceFailure(pending);
  if (observed.length < 2) return unknown('insufficient_sources', evidence, { local_candidate: Object.values(inputs).every(unavailable) });
  return observed.length === 4 ? pass(evidence) : warn('partial', evidence);
}

export function checkNet(sources, config) {
  const run = (name, evaluate) => check(`net.${name}`, null, evaluate);
  return [
    run('explorer.reachable', () => connected(field(sources.explorer, 'connected'))),
    run('explorer.index_lag', () => when(field(sources.explorer, 'headLag'), (lag) => {
      const evidence = { head_lag: lag, warn_threshold: 20, fail_threshold: 200 };
      return lag > 200 ? fail('stalled', evidence) : lag > 20 ? warn('lagging', evidence) : pass(evidence);
    })),
    run('rpc.reachable', () => {
      const source = field(sources.rpcHealth, 'reachable');
      return source.ok ? pass(evidenceFor(source)) : sourceFailure(source, 'fail');
    }),
    run('rpc.syncing', () => syncing(field(sources.rpcHealth, 'syncing'))),
    run('rpc.finality', () => when(sources.head, (head) => when(sources.finalized, (finalized) => {
      const lag = BigInt(head) - BigInt(finalized);
      const evidence = { head, finalized, lag: lag.toString(), warn_threshold: 20, fail_threshold: 100 };
      return lag > 100n ? fail('finality_stalled', evidence) : lag > 20n ? warn('finality_lag', evidence) : pass(evidence);
    }))),
    run('rpc.state_probe', () => !sources.metadata.ok ? sourceFailure(sources.metadata, 'fail') :
      sources.metadata.data.startsWith('0x6d657461') ? pass(evidenceFor(sources.metadata)) : fail('bad_metadata', evidenceFor(sources.metadata))),
    run('genesis.consistent', () => genesis(sources, config['expect-genesis'])),
    run('gateway.reachable', () => connected(field(sources.gateway, 'connected'))),
    run('gateway.syncing', () => syncing(field(sources.gateway, 'syncing'))),
    ...[['faucet', sources.chain], ['releases', sources.releases]].map(([name, source]) => run(`${name}.reachable`, () => {
      const reachability = field(source, 'reachable');
      return reachability.ok ? pass(evidenceFor(reachability)) : sourceFailure(reachability, 'warn');
    })),
  ];
}
