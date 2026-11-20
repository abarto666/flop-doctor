import { parseArgs } from 'node:util';
import { createBudget } from './budget.mjs';
import { aggregate, byGroupIdSubject, compareText, reattributeLocal } from './result.mjs';
import { COMMANDS, DEFAULTS, EXIT_CODES, TOOL, hash } from './config.mjs';
import { checkNet } from './checks/net.mjs';
import { checkMarket } from './checks/market.mjs';
import { checkMiner } from './checks/miner.mjs';
import { checkEndpoint } from './checks/endpoint.mjs';
import { fetchExplorerHealth, fetchOffers, fetchMiner, fetchAccount } from './sources/explorer.mjs';
import { fetchGatewayHealth, fetchModels } from './sources/gateway.mjs';
import { fetchFaucetChain, fetchFaucetLimits } from './sources/faucet.mjs';
import { fetchReleases } from './sources/releases.mjs';
import { fetchRpcGenesis, fetchRpcFinalizedHead, fetchRpcHeader, fetchRpcHealth, fetchRpcMetadata } from './sources/rpc.mjs';
import { endpointDeps, endpointTarget, fetchEndpointDns, fetchEndpointSessionInfo, fetchEndpointTls } from './sources/endpoint.mjs';
import { checkFingerprint, reportFingerprint } from './fingerprint.mjs';
import { redact } from './redact.mjs';
import { renderJson } from './render/json.mjs';
import { messageFor, renderText } from './render/text.mjs';
import { parseFlop } from './util/planck.mjs';
import { isSs58 } from './util/ss58.mjs';

const OPTIONS = Object.fromEntries([
  ...['json', 'redact', 'verbose', 'help', 'version'].map((name) => [name, { type: 'boolean' }]),
  ...['miner', 'model'].map((name) => [name, { type: 'string', multiple: true }]),
  ...[...Object.keys(DEFAULTS), 'expect-genesis', 'endpoint'].map((name) => [name, { type: 'string' }]),
]);
const HELP = `Usage:
  flop-doctor net
  flop-doctor market [--model <id|model_hash>]...
  flop-doctor miner <ss58> [--endpoint https://<host>[:port]]
  flop-doctor check [--miner <ss58>[=https://<host>[:port]]]... [--model <id|model_hash>]...

Options:
  --json, --redact, --verbose
  --timeout <seconds> (default 20, range 5–120)
  --min-fee-flop <decimal> (default 1, up to 18 fractional digits)
  --calib-warn-blocks <blocks> / --calib-fail-blocks <blocks> (7200 / 600)
  --cert-warn-days <days> / --cert-fail-days <days> (14 / 3)
  --expect-genesis <0x followed by 64 hex digits>
  --network <label> (devnet)
  --rpc, --explorer, --gateway, --faucet, --releases <https URL>
  --help, --version`;

class UsageError extends Error {}
const usage = (message) => { throw new UsageError(message); };
const validLabel = (value) => typeof value === 'string' && value.trim().length > 0 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);

function httpsUrl(value, option, endpoint = false) {
  let url;
  try { url = new URL(value); } catch { usage(`Invalid HTTPS URL for --${option}`); }
  if (url.protocol !== 'https:' || !/^https:\/\/[^/]/i.test(value) || url.username || url.password ||
      /^https:\/\/[^/?#]*@/i.test(value) || /[\s\\]/u.test(value) || url.port === '0') usage(`Invalid HTTPS URL for --${option}`);
  if (endpoint && (url.pathname !== '/' || /[?#]/.test(value))) usage('Endpoint URL must contain only the HTTPS host and optional port');
  url.hash = '';
  return url;
}

function parseCli(argv) {
  let parsed;
  try { parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS }); }
  catch (error) {
    const messages = { ERR_PARSE_ARGS_UNKNOWN_OPTION: 'Unknown option', ERR_PARSE_ARGS_INVALID_OPTION_VALUE: 'Invalid or missing option value' };
    usage(messages[error.code] ?? 'Invalid arguments');
  }
  const { values, positionals: [command, ...positionals] } = parsed;
  if (values.help || values.version) return { info: values.help ? HELP : TOOL.version };
  if (!COMMANDS.includes(command)) usage('Expected a command: net, market, miner, or check');
  if (positionals.length !== (command === 'miner' ? 1 : 0)) usage(command === 'miner' ? 'miner requires exactly one SS58 address' : 'Unexpected positional argument');
  if (values.miner && command !== 'check') usage('--miner is only supported by check');
  if (values.model && !['check', 'market'].includes(command)) usage('--model requires check or market');
  if ((values.model ?? []).some((value) => !validLabel(value))) usage('Invalid --model selector');

  const miners = command === 'miner' ? [[positionals[0], undefined]] : (values.miner ?? []).map((value) => {
    const index = value.indexOf('=');
    return index < 0 ? [value, undefined] : [value.slice(0, index), value.slice(index + 1)];
  });
  if (miners.length > 8) usage('At most eight --miner values are allowed');
  if (values.endpoint !== undefined && (miners.length !== 1 || miners[0][1] !== undefined)) usage('--endpoint requires exactly one miner and cannot be combined with an inline endpoint');
  const targets = miners.map(([address, inline], index) => {
    if (!isSs58(address)) usage('Invalid SS58 address or checksum');
    const endpoint = inline ?? values.endpoint;
    return { address, index: index + 1, ...(endpoint !== undefined && { endpoint: endpointTarget(httpsUrl(endpoint, 'endpoint', true)) }) };
  });

  const config = { ...DEFAULTS, ...values, command, targets };
  if (!/^\d+(?:\.\d+)?$/.test(config.timeout) || Number(config.timeout) < 5 || Number(config.timeout) > 120) usage('--timeout must be between 5 and 120 seconds');
  config.budgetMs = Math.round(Number(config.timeout) * 1000);
  try { config.minFee = parseFlop(config['min-fee-flop']); } catch { usage('--min-fee-flop must be a nonnegative decimal with at most 18 fractional digits'); }
  for (const [warn, fail] of [['calib-warn-blocks', 'calib-fail-blocks'], ['cert-warn-days', 'cert-fail-days']]) {
    for (const key of [warn, fail]) {
      if (!/^\d+$/.test(config[key]) || !Number.isSafeInteger(Number(config[key]))) usage(`--${key} must be a nonnegative safe integer`);
      config[key] = Number(config[key]);
    }
    if (config[warn] <= config[fail]) usage(`--${warn} must exceed --${fail}`);
  }
  if (config['expect-genesis'] !== undefined && !hash(config['expect-genesis'])) usage('--expect-genesis must be a 32-byte hex hash');
  if (!validLabel(config.network)) usage('Invalid --network label');
  for (const name of ['rpc', 'explorer', 'gateway', 'faucet', 'releases']) config[name] = httpsUrl(config[name], name).href;
  return config;
}

async function collect(config, deps) {
  const net = config.command === 'net' || config.command === 'check';
  const market = config.command === 'market' || config.command === 'check';
  const sources = [];
  const remember = (pending, private_alias, private_subject) => pending.then((source) => {
    sources.push({ ...source, private_alias, private_subject });
    return source;
  });
  const head = net || config.targets.length ? remember(fetchRpcHeader(deps)) : undefined;
  const releases = net || config.targets.length ? remember(fetchReleases(deps)) : undefined;
  const offers = market || config.targets.length ? remember(fetchOffers(deps)) : undefined;
  const netChecks = net && (async () => {
    const finalized = remember(fetchRpcFinalizedHead(deps)).then((first) => first.ok ? remember(fetchRpcHeader(deps, first.data)) : first);
    const results = await Promise.all([
      remember(fetchExplorerHealth(deps)), remember(fetchRpcHealth(deps)), head, finalized, remember(fetchRpcMetadata(deps)),
      remember(fetchRpcGenesis(deps)), remember(fetchFaucetChain(deps)), remember(fetchGatewayHealth(deps)), releases,
    ]);
    const [explorer, rpcHealth, best, final, metadata, genesis, chain, gateway, manifest] = results;
    return checkNet({ explorer, rpcHealth, head: best, finalized: final, metadata, genesis, chain, gateway, releases: manifest }, config);
  })();
  const marketChecks = market && (async () => {
    const [models, limits, page] = await Promise.all([remember(fetchModels(deps)), remember(fetchFaucetLimits(deps)), offers]);
    return checkMarket({ models, limits, offers: page }, config.model ?? []);
  })();
  const endpointProbes = new Map();
  const targets = config.targets.flatMap(({ address, endpoint, index }) => {
    const alias = `miner-${index}`;
    const miner = async () => {
      const [profile, account, manifest, height, page] = await Promise.all([
        remember(fetchMiner(deps, address), alias, address), remember(fetchAccount(deps, address), alias, address), releases, head, offers,
      ]);
      return checkMiner({ miner: profile, account, releases: manifest, head: height, offers: page }, config, address).map((row) => ({ ...row, alias }));
    };
    const probes = async () => {
      const endpointAlias = `endpoint-${index}`;
      let pending = endpointProbes.get(endpoint.url);
      if (!pending) {
        pending = (async () => {
          const dns = await fetchEndpointDns(deps, endpoint);
          if (dns.data?.reason !== 'ok') return { dns };
          const ip = dns.data.records[0];
          const [tls, sessionInfo] = await Promise.all([fetchEndpointTls(deps, endpoint, ip), fetchEndpointSessionInfo(deps, endpoint, ip)]);
          return { dns, tls, sessionInfo };
        })();
        endpointProbes.set(endpoint.url, pending);
      }
      const records = await pending;
      for (const source of Object.values(records)) sources.push({ ...source, private_alias: endpointAlias });
      return checkEndpoint(records, config, endpoint.authority).map((row) => ({ ...row, alias: endpointAlias }));
    };
    return [miner(), ...(endpoint ? [probes()] : [])];
  });
  const groups = await Promise.all([netChecks, marketChecks, ...targets].filter(Boolean));
  return { checks: reattributeLocal(groups.flat(), sources), sources };
}

function buildReport(config, collected, started, now) {
  const filtered = config.redact ? redact(collected.checks, collected.sources) : collected;
  const end = now();
  const checks = filtered.checks.map(({ alias, fp_key, ...row }) => ({ ...row,
    message: messageFor(row), fingerprint: checkFingerprint(config.network, { ...row, fp_key }),
  })).sort(byGroupIdSubject);
  const sources = filtered.sources.map(({ id, url, ok, failure, http_status, elapsed_ms }) => ({
    id, url, ok, failure: failure === 'budget_exhausted' ? 'timeout' : failure, http_status, elapsed_ms,
  })).sort((left, right) => compareText(left.id, right.id) || compareText(left.url, right.url));
  return { schema: 'flop-doctor/report/v1', tool: TOOL, network: config.network, command: config.command,
    generated_at: new Date(end).toISOString(), duration_ms: Math.max(0, Math.round(end - started)), budget_ms: config.budgetMs,
    redacted: Boolean(config.redact), ...aggregate(checks), fingerprint: reportFingerprint(config.network, checks), checks, sources };
}

const write = (stream) => (text) => new Promise((resolve, reject) => stream.write(`${text}\n`, (error) => error ? reject(error) : resolve()));

export async function main(argv, overrides = {}) {
  const deps = { fetch: globalThis.fetch, ...endpointDeps, now: Date.now, stdout: write(process.stdout), stderr: write(process.stderr),
    renderJson, renderText, ...overrides };
  let budget;
  try {
    const config = parseCli(argv);
    if (config.info) {
      await deps.stdout(config.info);
      return 0;
    }
    budget = createBudget(config.budgetMs, deps.now);
    const collected = await collect(config, { ...deps, config, budget, requests: new Map() });
    const report = buildReport(config, collected, budget.started, deps.now);
    budget.close();
    await deps.stdout(config.json ? deps.renderJson(report) : deps.renderText(report, config.verbose));
    return report.exit_code;
  } catch (error) {
    const kind = error instanceof UsageError ? 'usage' : 'internal';
    const exit_code = EXIT_CODES[kind];
    const message = kind === 'usage' ? error.message : 'Unexpected internal error';
    await deps.stderr(`flop-doctor: ${message}`);
    if (argv.includes('--json')) await deps.stdout(renderJson({ schema: 'flop-doctor/error/v1', exit_code, error: { kind, message } }));
    return exit_code;
  } finally {
    budget?.close();
  }
}
