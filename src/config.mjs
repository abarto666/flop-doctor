export const TOOL = Object.freeze({ name: 'flop-doctor', version: '1.0.0' });
export const COMMANDS = ['net', 'market', 'miner', 'check'];
export const FAILURES = ['timeout', 'transport', 'http_3xx', 'http_4xx', 'http_5xx', 'bad_json', 'rpc_error', 'schema'];
export const CAUSES = ['none', 'upstream', 'market', 'operator', 'local', 'schema', 'budget', 'internal'];
export const EXIT_CODES = Object.freeze({ pass: 0, warn: 1, fail: 2, unknown: 3, usage: 64, internal: 70 });
export const STATUS_ORDER = ['fail', 'unknown', 'warn', 'pass'];
export const DEFAULTS = Object.freeze({
  timeout: '20', 'min-fee-flop': '1', 'calib-warn-blocks': '7200', 'calib-fail-blocks': '600',
  'cert-warn-days': '14', 'cert-fail-days': '3', network: 'devnet',
  rpc: 'https://rpc.devnet.flop.network', explorer: 'https://explorer.devnet.flop.network',
  gateway: 'https://api.flop.network', faucet: 'https://faucet.flop.network',
  releases: 'https://flop.network/releases.json',
});
export const REQUEST_MS = 5000;
export const MAX_BODY = 8 * 1024 * 1024;
export const OFFER_LIMIT = 100;

export const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const string = (value) => typeof value === 'string' && value.length > 0;
export const bool = (value) => typeof value === 'boolean';
export const count = (value) => Number.isSafeInteger(value) && value >= 0;
export const amount = (value) => typeof value === 'string' && /^\d+$/.test(value);
export const block = (value) => amount(value) || count(value);
export const hash = (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
export const modelHash = (value) => typeof value === 'string' && /^(?:0x)?[0-9a-f]{64}$/i.test(value);
export const quantity = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0) ||
  (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value));
export const positive = (value) => typeof value === 'number' ? value > 0 : /[1-9]/.test(value);
