import { EXIT_CODES, STATUS_ORDER } from './config.mjs';
import { evidenceFor } from './http.mjs';
import { REGISTRY } from './registry.mjs';

export const outcome = (status = 'pass', reason = 'ok', evidence = {}, extras = {}) => ({ status, reason, evidence, ...extras });
export const pass = (evidence, extras) => outcome('pass', 'ok', evidence, extras);
export const warn = (reason, evidence, extras) => outcome('warn', reason, evidence, extras);
export const fail = (reason, evidence, extras) => outcome('fail', reason, evidence, extras);
export const unknown = (reason, evidence, extras) => outcome('unknown', reason, evidence, extras);
export const unavailable = (source) => ['transport', 'timeout'].includes(source.failure);

export function sourceFailure(source, status = 'unknown', reason = status === 'unknown' ? `src_${source.failure}` : source.failure) {
  return source.failure === 'budget_exhausted' ? unknown('budget_exhausted', evidenceFor(source), { cause_class: 'budget' }) :
    outcome(status, reason, evidenceFor(source), {
      cause_class: status === 'unknown' && source.failure === 'schema' ? 'schema' : 'upstream', local_candidate: unavailable(source),
    });
}

export const when = (source, evaluate) => source.ok ? evaluate(source.data) : sourceFailure(source);

export function check(id, subject, evaluate) {
  const entry = REGISTRY[id];
  if (!entry) throw new TypeError('Unregistered check');
  const { group, cause_class } = entry;
  try {
    const verdict = evaluate();
    if (!STATUS_ORDER.includes(verdict.status) || !entry.reasons.includes(verdict.reason) ||
      (verdict.status === 'pass') !== (verdict.reason === 'ok')) throw new TypeError('Invalid check verdict');
    return { id, group, subject, cause_class: verdict.status === 'pass' ? 'none' : cause_class, ...verdict };
  } catch {
    return { id, group, subject, ...unknown('check_crashed', {}, { cause_class: 'internal' }) };
  }
}

export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const byIdSubject = (left, right) => compareText(left.id, right.id) || compareText(left.subject ?? '', right.subject ?? '');
export const byGroupIdSubject = (left, right) => compareText(left.group, right.group) || byIdSubject(left, right);

export function aggregate(checks) {
  const summary = { pass: 0, warn: 0, fail: 0, unknown: 0 };
  for (const row of checks) summary[row.status]++;
  const status = STATUS_ORDER.find((candidate) => summary[candidate]) ?? 'pass';
  return { status, exit_code: EXIT_CODES[status], summary };
}

export function reattributeLocal(checks, sources) {
  const upstreams = sources.filter((source) => !source.id.startsWith('endpoint.'));
  const hosts = new Set(upstreams.map((source) => new URL(source.url).hostname.replace(/\.$/, '')));
  const local = hosts.size >= 3 && upstreams.every(unavailable);
  return checks.map(({ local_candidate, ...result }) => local && local_candidate ? { ...result, cause_class: 'local' } : result);
}
