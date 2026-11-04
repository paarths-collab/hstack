/** Canonicalize equivalent draft-07 spelling without removing constraints. */
export function canonicalInputSchema(schema) {
  const resolveRef = (ref) => {
    if (!ref.startsWith('#/')) throw new Error('Only local schema references are supported.');
    return ref.slice(2).split('/').reduce((value, key) => value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], schema);
  };
  const visit = (value, refs = new Set()) => {
    if (Array.isArray(value)) return value.map((item) => visit(item, refs));
    if (!value || typeof value !== 'object') return value;
    if (value.$ref) {
      if (refs.has(value.$ref)) throw new Error('Recursive schema needs separate review.');
      const target = resolveRef(value.$ref);
      if (!target) throw new Error('Unresolved schema reference.');
      const { $ref, ...siblings } = value;
      return visit({ ...target, ...siblings }, new Set([...refs, $ref]));
    }
    const copy = { ...value };
    if (copy.type === 'object') copy.additionalProperties ??= true;
    if (copy.additionalProperties && typeof copy.additionalProperties === 'object' && !Object.keys(copy.additionalProperties).length) copy.additionalProperties = true;
    // JSON object keys are already strings; this adds no validation constraint.
    if (JSON.stringify(copy.propertyNames) === '{"type":"string"}') delete copy.propertyNames;
    if (copy.type === 'array' && copy.items === undefined) copy.items = {};
    if (Array.isArray(copy.required)) copy.required = [...copy.required].sort();
    return Object.fromEntries(Object.keys(copy).sort().map((key) => [key, visit(copy[key], refs)]));
  };
  return visit(schema);
}
