import { createHash } from 'node:crypto';

const PREFIX = 'flop-doctor/v1';
const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);

export function checkFingerprint(network, { id, subject, status, cause_class, reason, fp_key }) {
  return digest([PREFIX, network, id, subject ?? '', status, cause_class, reason, fp_key ?? ''].join('\n'));
}

export function reportFingerprint(network, checks) {
  const alerts = checks.filter((row) => row.status !== 'pass').map((row) => row.fingerprint).sort();
  return digest(alerts.length ? alerts.join('\n') : `${PREFIX}\n${network}\nok`);
}
