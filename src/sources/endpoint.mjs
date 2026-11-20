import { Resolver } from 'node:dns/promises';
import { Agent, get } from 'node:https';
import { isIP } from 'node:net';
import { connect, checkServerIdentity } from 'node:tls';
import { elapsed, errorCode, failureFor } from '../http.mjs';
import { classifyIp } from '../util/netguard.mjs';

const ABSENT = new Set(['ENOTFOUND', 'ENODATA']);
const TRUST_ERRORS = /^(?:ERR_TLS_CERT_|CERT_|CRL_|X509_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_|INVALID_CA|INVALID_PURPOSE|PATH_LENGTH_EXCEEDED|ERROR_IN_CERT_|KEYUSAGE_|HOSTNAME_MISMATCH|IP_ADDRESS_MISMATCH)/;

async function resolve(family, hostname, { signal }) {
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.throwIfAborted();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    return await resolver[family](hostname);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function tlsConnect({ ip, hostname, port, signal }) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const socket = connect({ host: ip, port, servername: hostname, rejectUnauthorized: true, checkServerIdentity });
    const abort = () => socket.destroy();
    signal.addEventListener('abort', abort, { once: true });
    socket.once('close', () => signal.removeEventListener('abort', abort));
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      resolve({ authorized: socket.authorized, authorizationError: socket.authorizationError, validTo: socket.getPeerCertificate().valid_to });
      socket.destroy();
    });
  });
}

function httpsGet({ ip, hostname, port, authority, signal }) {
  return new Promise((resolve, reject) => {
    const agent = new Agent({ keepAlive: false, proxyEnv: {} });
    const request = get({ hostname: ip, port, servername: hostname, rejectUnauthorized: true, checkServerIdentity,
      path: '/session/info', headers: { host: authority }, agent, signal }, (response) => {
      resolve(response.statusCode);
      response.destroy();
    });
    request.once('error', reject);
    request.once('close', () => agent.destroy());
  });
}

export const endpointDeps = { resolve4: resolve.bind(null, 'resolve4'), resolve6: resolve.bind(null, 'resolve6'), tlsConnect, httpsGet };

async function probe(deps, id, url, probeFn) {
  const started = deps.now();
  let result;
  try {
    result = await deps.budget.run(probeFn);
  } catch (error) {
    result = { ok: false, failure: failureFor(error), error_code: errorCode(error) };
  }
  return { id: `endpoint.${id}`, url, http_status: null, elapsed_ms: elapsed(deps.now, started), failure: null, ...result };
}

async function addresses(resolveFamily, hostname, signal) {
  try {
    const answer = await resolveFamily(hostname, { signal });
    if (!Array.isArray(answer)) return { records: [], error_code: 'EBADRESP' };
    return { records: answer };
  } catch (error) {
    const code = errorCode(error);
    return { records: [], ...(ABSENT.has(code) ? {} : { error_code: code ?? 'ERESOLVE', failure: failureFor(error) }) };
  }
}

export const endpointTarget = (url) => ({
  url: url.href, authority: url.host, hostname: url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, ''), port: Number(url.port || 443),
});

export function fetchEndpointDns(deps, target) {
  return probe(deps, 'dns', target.url, async (signal) => {
    if (isIP(target.hostname)) return { ok: true, data: { reason: 'ip_literal' } };
    if (target.hostname.toLowerCase().endsWith('.ts.net')) return { ok: true, data: { reason: 'tailscale_domain' } };
    const answers = await Promise.all([addresses(deps.resolve4, target.hostname, signal), addresses(deps.resolve6, target.hostname, signal)]);
    const records = answers.flatMap((answer) => answer.records);
    const classes = records.map(classifyIp);
    const lookupError = answers.find((answer) => answer.error_code);
    const error_code = lookupError?.error_code;
    const reason = classes.includes('private') ? 'private_address' : classes.includes('fake') ? 'fake_ip_suspected' :
      error_code || classes.includes('invalid') ? 'resolver_error' : !records.length ? 'no_records' : 'ok';
    return { ok: reason !== 'resolver_error', ...(reason === 'resolver_error' && { failure: lookupError?.failure ?? 'schema' }),
      error_code, data: { reason, records: records.filter((record, index) => classes[index] !== 'invalid') } };
  });
}

export function fetchEndpointTls(deps, target, ip) {
  return probe(deps, 'tls', target.url, async (signal) => {
    const cert = await deps.tlsConnect({ ...target, ip, signal });
    if (cert?.authorized === false) return { ok: false, failure: 'transport', untrusted: true,
      error_code: errorCode({ code: cert.authorizationError }) };
    const until = Date.parse(cert?.validTo);
    if (cert?.authorized !== true || !Number.isFinite(until)) return { ok: false, failure: 'transport' };
    return { ok: true, data: { valid_to: cert.validTo, days_remaining: (until - deps.now()) / 86400000 } };
  }).then((source) => ({ ...source, untrusted: source.untrusted || TRUST_ERRORS.test(source.error_code ?? '') }));
}

export function fetchEndpointSessionInfo(deps, target, ip) {
  return probe(deps, 'session_info', new URL('/session/info', target.url).href, async (signal) => {
    const status = await deps.httpsGet({ ...target, ip, signal });
    if (!Number.isInteger(status) || status < 100 || status > 599) return { ok: false, failure: 'transport' };
    return { ok: true, http_status: status };
  });
}
