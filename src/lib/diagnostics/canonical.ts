/*
 * The canonical key order of a report (original TRACE module, MIT): fields in the order of electron/diagnostic-schema.json, record keys sorted, exactly
 * what the validator of the main process writes (electron/diagnostics.cjs). The review dialog shows this text and the main process saves it, so the
 * user reads what lands on the disk, byte for byte; collect.test.ts and the session tests prove the agreement.
 */
import schema from '../../../electron/diagnostic-schema.json';

interface Node { ref?: string; type?: string; properties?: Record<string, Node>; items?: Node | Node[]; values?: Node }
const DEFINITIONS = schema.definitions as unknown as Record<string, Node>;
const resolve = (node: Node): Node => (node.ref ? DEFINITIONS[node.ref] : node);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function arrange(value: unknown, rawNode: Node): unknown {
  const node = resolve(rawNode);
  if (value === null || value === undefined) return value;
  switch (node.type) {
    case 'object': {
      if (!isObject(value) || !node.properties) return value;
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node.properties)) if (Object.hasOwn(value, key)) out[key] = arrange(value[key], child);
      return out;
    }
    case 'array': return Array.isArray(value) && node.items && !Array.isArray(node.items) ? value.map(item => arrange(item, node.items as Node)) : value;
    case 'tuple': return Array.isArray(value) && Array.isArray(node.items) ? value.map((item, index) => arrange(item, (node.items as Node[])[index])) : value;
    case 'record': {
      if (!isObject(value) || !node.values) return value;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) out[key] = arrange(value[key], node.values);
      return out;
    }
    default: return value;
  }
}

/** A copy of `report` with its keys in the canonical order (fields that are not in the schema are dropped, as the validator would refuse them). */
export function canonicalReport<T>(report: T): T {
  return arrange(report, schema.root as unknown as Node) as T;
}
