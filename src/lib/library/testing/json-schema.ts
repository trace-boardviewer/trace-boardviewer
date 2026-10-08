/*
 * A validator for the JSON Schema subset the ground-truth schema uses: type, enum, const, anyOf, pattern, minimum, maximum, minItems,
 * items, properties, required, additionalProperties and local $ref into $defs. The schema is a normal JSON Schema file, so other tools
 * can validate with a full implementation; this one exists so the repository needs no extra dependency. A keyword outside the subset
 * throws, so the schema cannot start to rely on something that is not checked.
 */

type Schema = { [key: string]: unknown };

const ANNOTATIONS = new Set(['$schema', 'title', 'description', '$defs', '$comment']);
const SUPPORTED = new Set(['type', 'enum', 'const', 'anyOf', 'pattern', 'minimum', 'maximum', 'minItems', 'items', 'properties', 'required', 'additionalProperties', '$ref', ...ANNOTATIONS]);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(type: string, value: unknown): boolean {
  const actual = typeOf(value);
  if (type === 'integer') return actual === 'number' && Number.isInteger(value);
  return actual === type;
}

export function validateJson(schema: Schema, value: unknown, maxErrors = 50): string[] {
  const errors: string[] = [];
  const root = schema;
  const resolve = (ref: string): Schema => {
    const match = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref);
    const target = match ? (root.$defs as Schema | undefined)?.[match[1]] : undefined;
    if (!target) throw new Error(`unsupported or unknown $ref ${ref}`);
    return target as Schema;
  };
  const check = (node: Schema, data: unknown, at: string): boolean => {
    for (const key of Object.keys(node)) if (!SUPPORTED.has(key)) throw new Error(`unsupported schema keyword "${key}" at ${at || '/'}`);
    const before = errors.length;
    const fail = (message: string): void => { if (errors.length < maxErrors) errors.push(`${at || '/'}: ${message}`); };
    if (typeof node.$ref === 'string') { if (!check(resolve(node.$ref), data, at)) return false; }
    if ('const' in node && data !== node.const) fail(`must be ${JSON.stringify(node.const)}`);
    if (Array.isArray(node.enum) && !node.enum.includes(data)) fail(`must be one of ${node.enum.map(entry => JSON.stringify(entry)).join(', ')}`);
    if (typeof node.type === 'string' && !matchesType(node.type, data)) { fail(`must be ${node.type}, not ${typeOf(data)}`); return false; }
    if (Array.isArray(node.anyOf)) {
      const options = node.anyOf as Schema[];
      const matched = options.some(option => { const mark = errors.length; const ok = check(option, data, at); if (!ok) errors.length = mark; return ok; });
      if (!matched) fail('matches none of the allowed shapes');
    }
    if (typeof data === 'string' && typeof node.pattern === 'string' && !new RegExp(node.pattern).test(data)) fail(`must match ${node.pattern}`);
    if (typeof data === 'number') {
      if (typeof node.minimum === 'number' && data < node.minimum) fail(`must be at least ${node.minimum}`);
      if (typeof node.maximum === 'number' && data > node.maximum) fail(`must be at most ${node.maximum}`);
    }
    if (Array.isArray(data)) {
      if (typeof node.minItems === 'number' && data.length < node.minItems) fail(`must have at least ${node.minItems} items`);
      if (node.items && typeof node.items === 'object') data.forEach((entry, index) => { if (errors.length < maxErrors) check(node.items as Schema, entry, `${at}/${index}`); });
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const record = data as Record<string, unknown>;
      const properties = (node.properties ?? {}) as Record<string, Schema>;
      if (Array.isArray(node.required)) for (const name of node.required as string[]) if (!(name in record)) fail(`is missing "${name}"`);
      for (const name of Object.keys(record)) {
        if (errors.length >= maxErrors) break;
        if (properties[name]) check(properties[name], record[name], `${at}/${name}`);
        else if (node.additionalProperties === false) fail(`has the unknown property "${name}"`);
        else if (node.additionalProperties && typeof node.additionalProperties === 'object') check(node.additionalProperties as Schema, record[name], `${at}/${name}`);
      }
    }
    return errors.length === before;
  };
  check(schema, value, '');
  return errors;
}
