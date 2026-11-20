import { REGISTRY } from './registry.mjs';

const KEEP = new Set(['warn_threshold', 'fail_threshold', 'head_source', 'truncated']);
const HIDDEN = '[redacted]';

export function redact(checks, sources) {
  return {
    checks: checks.map(({ alias, ...row }) => {
      if (row.group !== 'miner' && row.group !== 'endpoint') return row;
      const sensitive = REGISTRY[row.id].sensitiveEvidenceKeys;
      return { ...row, subject: alias, evidence: Object.fromEntries(Object.entries(row.evidence).map(([key, value]) =>
        [key, typeof value === 'boolean' || (KEEP.has(key) && !sensitive.includes(key)) ? value : HIDDEN])) };
    }),
    sources: sources.map(({ private_alias, private_subject, ...source }) => {
      if (!private_alias) return source;
      const url = new URL(source.url);
      if (source.id.startsWith('endpoint.')) url.host = private_alias;
      else url.pathname = url.pathname.split('/').map((part) => part === private_subject ? private_alias : part).join('/');
      if (source.id.startsWith('endpoint.')) url.port = '';
      return { ...source, url: url.href };
    }),
  };
}
