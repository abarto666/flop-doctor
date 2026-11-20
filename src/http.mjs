import { BUDGET_EXHAUSTED, REQUEST_TIMEOUT } from './budget.mjs';
import { MAX_BODY, object } from './config.mjs';

export const elapsed = (now, start) => Math.max(0, Math.round(now() - start));
export const evidenceFor = (source) => Object.fromEntries([
  ['http_status', source.http_status], ['elapsed_ms', source.elapsed_ms], ['error_code', source.error_code],
].filter(([, value]) => value !== null && value !== undefined));

export function errorCode(error) {
  const code = error?.cause?.code ?? error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(code) && code.length < 65
    ? code : undefined;
}

export function failureFor(error) {
  if (error === BUDGET_EXHAUSTED) return 'budget_exhausted';
  if (error === REQUEST_TIMEOUT || error?.name === 'TimeoutError' ||
      ['ETIMEDOUT', 'ETIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(errorCode(error))) return 'timeout';
  return 'transport';
}

export function invalid(source) {
  return { ...source, ok: false, failure: 'schema', data: undefined };
}

export function select(source, valid, value) {
  return !source.ok ? source : valid ? { ...source, data: value } : invalid(source);
}

export function fields(source, readers) {
  if (!source.ok) return source;
  if (!object(source.data)) return invalid(source);
  const data = {};
  for (const [key, [read, valid]] of Object.entries(readers)) {
    const value = read(source.data);
    data[key] = select(source, valid(value), value);
  }
  return { ...source, data, failure: Object.values(data).some((field) => !field.ok) ? 'schema' : null,
    ok: Object.values(data).every((field) => field.ok), fieldwise: true };
}

export const field = (source, key) => source.fieldwise ? source.data[key] : source;

export function apiUrl(base, path) {
  const url = new URL(base);
  const target = new URL(path, url.origin);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${target.pathname}`;
  for (const [key, value] of target.searchParams) url.searchParams.set(key, value);
  return url.href;
}

const discard = (promise) => { void promise?.catch(() => {}); };

async function readJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_BODY) {
    discard(response.body?.cancel());
    throw new SyntaxError();
  }
  if (!response.body) throw new SyntaxError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new SyntaxError();
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(''));
  } catch (error) {
    discard(reader.cancel());
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function requestJson(deps, id, url, options = {}) {
  const key = options.rpc
    ? `POST ${url} ${options.rpc.method}:${JSON.stringify(options.rpc.params ?? [])}`
    : `GET ${url}`;
  let request = deps.requests?.get(key);
  if (!request) {
    request = performRequest(deps, url, options);
    deps.requests?.set(key, request);
  }
  return { id, ...await request };
}

async function performRequest(deps, url, { rpc }) {
  const started = deps.now();
  let status = null;
  let result;
  try {
    result = await deps.budget.run(async (signal) => {
      const response = await deps.fetch(url, {
        method: rpc ? 'POST' : 'GET', redirect: 'manual', signal,
        ...(rpc && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(rpc) }),
      });
      status = response.status;
      if (status !== 200) {
        discard(response.body?.cancel());
        const failure = status >= 500 ? 'http_5xx' : status >= 400 ? 'http_4xx' : status >= 300 ? 'http_3xx' : 'schema';
        return { ok: false, failure };
      }
      try {
        return { ok: true, data: await readJson(response) };
      } catch (error) {
        if (error instanceof SyntaxError || (error instanceof TypeError && error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA')) {
          return { ok: false, failure: 'bad_json' };
        }
        throw error;
      }
    });
  } catch (error) {
    result = { ok: false, failure: failureFor(error), error_code: errorCode(error) };
  }
  return { url, http_status: status, elapsed_ms: elapsed(deps.now, started), failure: null, ...result };
}
