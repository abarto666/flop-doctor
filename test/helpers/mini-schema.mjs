const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const types = {
  object, array: Array.isArray, null: (value) => value === null, integer: Number.isInteger, number: Number.isFinite,
  boolean: (value) => typeof value === 'boolean', string: (value) => typeof value === 'string',
};
const annotations = new Set(['$schema', '$defs', 'title']);

export function validate(schema, instance) {
  function walk(rule, value, path) {
    const errors = [];
    const fail = (message) => errors.push(`${path}: ${message}`);
    for (const [key, expected] of Object.entries(rule)) {
      if (annotations.has(key)) continue;
      switch (key) {
        case '$ref': {
          if (!expected.startsWith('#/')) throw new Error('External schema reference');
          const ref = expected.slice(2).split('/').reduce((current, part) => current[part.replaceAll('~1', '/').replaceAll('~0', '~')], schema);
          errors.push(...walk(ref, value, path));
          break;
        }
        case 'type':
          if (![expected].flat().some((type) => types[type](value))) fail(`expected ${expected}`);
          break;
        case 'const':
          if (value !== expected) fail('unexpected constant');
          break;
        case 'enum':
          if (!expected.includes(value)) fail('not an enumerated value');
          break;
        case 'anyOf':
          if (!expected.some((branch) => walk(branch, value, path).length === 0)) fail('no matching branch');
          break;
        case 'required':
          if (object(value)) for (const field of expected) if (!Object.hasOwn(value, field)) fail(`missing ${field}`);
          break;
        case 'properties':
          if (object(value)) for (const [field, shape] of Object.entries(expected)) {
            if (Object.hasOwn(value, field)) errors.push(...walk(shape, value[field], `${path}.${field}`));
          }
          break;
        case 'additionalProperties':
          if (object(value)) for (const [field, entry] of Object.entries(value)) {
            if (Object.hasOwn(rule.properties ?? {}, field)) continue;
            if (expected === false) fail(`unexpected ${field}`);
            else if (object(expected)) errors.push(...walk(expected, entry, `${path}.${field}`));
          }
          break;
        case 'items':
          if (Array.isArray(value)) for (const [index, entry] of value.entries()) errors.push(...walk(expected, entry, `${path}[${index}]`));
          break;
        case 'pattern':
          if (typeof value === 'string' && !new RegExp(expected, 'u').test(value)) fail('pattern mismatch');
          break;
        case 'format':
          if (typeof value !== 'string') break;
          if (expected === 'date-time') {
            if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(value) || !Number.isFinite(Date.parse(value))) fail('invalid date-time');
          } else if (expected === 'uri') {
            if (!URL.canParse(value)) fail('invalid URI');
          } else throw new Error(`Unsupported format ${expected}`);
          break;
        case 'minimum':
          if (typeof value === 'number' && value < expected) fail('below minimum');
          break;
        case 'maximum':
          if (typeof value === 'number' && value > expected) fail('above maximum');
          break;
        case 'minLength':
          if (typeof value === 'string' && [...value].length < expected) fail('below minimum length');
          break;
        default: throw new Error(`Unsupported schema keyword ${key}`);
      }
    }
    return errors;
  }
  return walk(schema, instance, '$');
}
