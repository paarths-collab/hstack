import { Ajv, addFormats, AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/client';
import { DiscoveryError } from './errors.js';

/** Google protobuf formats need exact decimal validation, not Number coercion.
 * Keep public schemas untouched; transform a validation-only copy for the SDK's
 * supported custom AJV interface. Unreviewed formats/dialects fail closed. */
export function createBigQuerySchemaValidator() {
  const ajv = new Ajv({ strict: false, validateSchema: true, validateFormats: true, allErrors: false });
  addFormats(ajv);
  const decimal = (value: string, signed: boolean): boolean => {
    if (!(signed ? /^-?\d{1,19}$/ : /^\d{1,20}$/).test(value)) return false;
    const number = BigInt(value);
    return signed ? number >= -(2n ** 63n) && number < 2n ** 63n : number >= 0 && number < 2n ** 64n;
  };
  ajv.addFormat('google-int64-string', { type: 'string', validate: (value: string) => decimal(value, true) });
  // JSON numbers outside this range have already lost integer precision.
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  ajv.addFormat('uint64', { type: 'string', validate: (value: string) => decimal(value, false) });
  ajv.addFormat('google-duration', { type: 'string', validate: (value: string) => {
    const match = /^-?(\d{1,12})(?:\.\d{1,9})?s$/.exec(value);
    return !!match && BigInt(match[1]!) <= 315576000000n;
  } });
  const validator = new AjvJsonSchemaValidator(ajv);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    if (node.$schema !== undefined && node.$schema !== 'http://json-schema.org/draft-07/schema#') throw new DiscoveryError('BigQuery schema dialect changed; review it before calling tools.', { code: 'UNAVAILABLE', outcome: 'not_sent' });
    if (node.format !== undefined && (typeof node.format !== 'string' || !Object.hasOwn(ajv.formats, node.format))) throw new DiscoveryError('BigQuery schema format changed; review it before calling tools.', { code: 'UNAVAILABLE', outcome: 'not_sent' });
    if (node.format === 'int64' && node.type === 'string') node.format = 'google-int64-string';
    // Visit schema positions only. Property names, defaults, examples and enum
    // objects can themselves contain keys named format or $schema.
    for (const key of ['$defs','definitions','properties','patternProperties','dependentSchemas']) {
      const map = node[key];
      if (map && typeof map === 'object' && !Array.isArray(map)) Object.values(map).forEach(visit);
    }
    for (const key of ['allOf','anyOf','oneOf','prefixItems']) if (Array.isArray(node[key])) node[key].forEach(visit);
    for (const key of ['additionalProperties','additionalItems','items','contains','propertyNames','not','if','then','else','unevaluatedProperties','unevaluatedItems','contentSchema']) {
      if (Array.isArray(node[key])) node[key].forEach(visit); else visit(node[key]);
    }
    const dependencies = node.dependencies;
    if (dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)) Object.values(dependencies).forEach(visit);
  };
  return { getValidator<T>(schema: JsonSchemaType) {
    const copy = structuredClone(schema); visit(copy); return validator.getValidator<T>(copy);
  } };
}
