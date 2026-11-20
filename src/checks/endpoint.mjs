import { evidenceFor } from '../http.mjs';
import { check, fail, pass, sourceFailure, unknown, warn } from '../result.mjs';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function checkEndpoint({ dns, tls, sessionInfo }, config, subject) {
  const run = (id, evaluate) => check(`endpoint.${id}`, subject, evaluate);
  const dnsResult = run('dns', () => {
    if (dns.failure === 'budget_exhausted') return sourceFailure(dns);
    const reason = dns.data?.reason ?? 'resolver_error';
    const evidence = { ...evidenceFor(dns), ...(dns.data?.records && { addresses: dns.data.records }) };
    return reason === 'ok' ? pass(evidence) : reason === 'resolver_error' || reason === 'fake_ip_suspected' ?
      unknown(reason, evidence, { cause_class: 'local' }) : fail(reason, evidence);
  });
  return [dnsResult,
    run('tls', () => {
      if (dnsResult.status !== 'pass') return unknown('skipped_dns');
      if (tls.failure === 'budget_exhausted') return sourceFailure(tls);
      const evidence = evidenceFor(tls);
      if (!tls.ok) return fail(tls.untrusted ? 'untrusted' : 'handshake_failed', evidence);
      const warnThreshold = config['cert-warn-days'];
      const failThreshold = config['cert-fail-days'];
      Object.assign(evidence, tls.data, { warn_threshold: warnThreshold, fail_threshold: failThreshold });
      return tls.data.days_remaining <= failThreshold ? fail('expired_or_imminent', evidence) :
        tls.data.days_remaining <= warnThreshold ? warn('expiring', evidence) : pass(evidence);
    }),
    run('session_info', () => {
      if (dnsResult.status !== 'pass') return unknown('skipped_dns');
      if (sessionInfo.failure === 'budget_exhausted') return sourceFailure(sessionInfo);
      const evidence = evidenceFor(sessionInfo);
      if (!sessionInfo.ok) return fail('unreachable', evidence);
      const status = sessionInfo.http_status;
      return status === 401 ? pass(evidence) : fail(REDIRECTS.has(status) ? 'redirect' :
        status === 200 ? 'unauthenticated_access' : 'unexpected_status', evidence);
    }),
  ];
}
