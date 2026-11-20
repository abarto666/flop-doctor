import assert from 'node:assert/strict';
import { main } from '../../src/cli.mjs';
import { FINALIZED_HASH, healthy, NOW, PUBLIC_IP, certificate } from '../fixtures/interfaces.mjs';

const mockError = (code) => Object.assign(new Error('private raw network error'), { code });
export { mockError };

function respond(value) {
  if (value instanceof Error) throw value;
  if (value instanceof Response) return value;
  if (typeof value === 'number') return new Response(null, { status: value });
  return Response.json(value);
}

export function mockDeps(options = {}) {
  const fixtures = structuredClone(healthy);
  options.mutate?.(fixtures);
  const calls = { fetch: [], resolve4: [], resolve6: [], tlsConnect: [], httpsGet: [] };
  const out = [];
  const err = [];

  async function fetch(url, init) {
    const target = new URL(url);
    const rpc = init.method === 'POST' ? JSON.parse(init.body) : null;
    const path = target.pathname;
    const key = rpc ? rpc.method === 'chain_getHeader' && rpc.params.length ? `${rpc.method}.finalized` : rpc.method : path;
    const fallback = Object.keys(fixtures).find((pattern) => pattern.endsWith('/') && path.startsWith(pattern));
    const entry = { url, init, host: target.hostname, key, rpc };
    calls.fetch.push(entry);
    assert.equal(init.redirect, 'manual');
    assert.equal(new Headers(init.headers).has('authorization'), false);
    if (rpc) {
      assert.ok(Object.hasOwn(fixtures.rpc, key));
      if (key === 'chain_getHeader.finalized') assert.deepEqual(rpc.params, [FINALIZED_HASH]);
      assert.equal(target.search, '');
    } else {
      assert.equal(init.method, 'GET');
      assert.ok(Object.hasOwn(fixtures, key) || fallback, `Unexpected GET URL: ${url}`);
      if (path === '/api/session-offers') assert.equal(target.searchParams.get('limit'), '100');
    }
    const fixture = rpc ? fixtures.rpc[key] : fixtures[key] ?? fixtures[fallback];
    return respond(options.fetch ? await options.fetch(entry, fixture) : fixture);
  }

  const deps = {
    fetch, now: options.now ?? (() => NOW),
    stdout: (value) => out.push(value), stderr: (value) => err.push(value),
  };
  const defaults = { resolve4: () => [PUBLIC_IP], resolve6: () => [], tlsConnect: () => certificate(30), httpsGet: () => 401 };
  for (const [name, fallback] of Object.entries(defaults)) deps[name] = (...args) => {
    calls[name].push(args);
    return (options[name] ?? fallback)(...args);
  };
  Object.assign(deps, options.extra);
  return { deps, calls, out, err };
}

export async function run(args, options = {}, json = true) {
  const mock = mockDeps(options);
  const exit = await main([...args, ...(json ? ['--json'] : [])], mock.deps);
  assert.equal(mock.out.length, 1);
  return { ...mock, exit, text: mock.out[0], report: json ? JSON.parse(mock.out[0]) : undefined };
}

export function row(report, id, subject) {
  const result = report.checks.find((candidate) => candidate.id === id && (subject === undefined || candidate.subject === subject));
  assert.ok(result, `Missing check ${id} ${subject ?? ''}`);
  return result;
}

export function verdict(report, id, status, reason, cause, subject) {
  const result = row(report, id, subject);
  assert.equal(result.status, status, id);
  assert.equal(result.reason, reason, id);
  if (cause) assert.equal(result.cause_class, cause, id);
  return result;
}
