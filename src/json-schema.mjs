function fail(path, message) {
  throw new Error(`Invalid tool arguments at ${path}: ${message}`);
}

export function validateJsonSchema(schema, value, options = {}) {
  const state = {
    nodes: 0,
    maxNodes: options.maxNodes ?? 50_000,
    maxDepth: options.maxDepth ?? 20,
  };
  validateNode(schema, value, '$', 0, state);
  return value;
}

function validateNode(schema, value, path, depth, state) {
  state.nodes += 1;
  if (state.nodes > state.maxNodes) fail(path, 'structure is too large');
  if (depth > state.maxDepth) fail(path, 'structure is too deeply nested');
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    fail(path, `must be one of: ${schema.enum.join(', ')}`);
  }

  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      fail(path, 'must be an object');
    }
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required');
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) validateNode(properties[key], item, `${path}.${key}`, depth + 1, state);
      else if (schema.additionalProperties === false) fail(`${path}.${key}`, 'is not allowed');
    }
    return;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) fail(path, 'must be an array');
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(path, `must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(path, `must have at most ${schema.maxItems} items`);
    for (let index = 0; index < value.length; index += 1) {
      validateNode(schema.items, value[index], `${path}[${index}]`, depth + 1, state);
    }
    return;
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') fail(path, 'must be a string');
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(path, `must have at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(path, `must have at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern, 'u')).test(value)) fail(path, 'has an invalid format');
    return;
  }

  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') fail(path, 'must be a boolean');
    return;
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value))) {
      fail(path, `must be a finite ${schema.type}`);
    }
    if (schema.minimum !== undefined && value < schema.minimum) fail(path, `must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(path, `must be at most ${schema.maximum}`);
  }
}
