import { object, string } from '../config.mjs';
import { fields, requestJson } from '../http.mjs';
import { compareSemver, parseSemver } from '../util/semver.mjs';

export async function fetchReleases(deps) {
  return fields(await requestJson(deps, 'releases.manifest', deps.config.releases), {
    reachable: [(body) => [body.cli?.latest, body['miner-worker']?.latest], (versions) => versions.every(string)],
    worker: [(body) => body['miner-worker'], (value) => Boolean(parseSemver(value?.minimum) &&
      parseSemver(value?.latest) && compareSemver(value.minimum, value.latest) <= 0)],
    models: [(body) => body.models, object],
  });
}
