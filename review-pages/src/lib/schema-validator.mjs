// Minimal JSON Schema (draft-07 subset) validator: type, required,
// properties, additionalProperties, items, enum, pattern, minimum. This
// is deliberately not a general-purpose library — Review Pages schemas
// only use this subset, and depending on a full validator would be more
// machinery than the contract needs.

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateNode(schema, value, path, errors) {
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
    return;
  }

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const matches =
      expected.includes(actual) || (expected.includes("integer") && actual === "number" && Number.isInteger(value));
    if (!matches) {
      errors.push(`${path}: expected type ${expected.join("|")}, got ${actual}`);
      return;
    }
  }

  if (typeof value === "string" && schema.pattern !== undefined) {
    if (!new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path}: must be >= ${schema.minimum}`);
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => validateNode(schema.items, item, `${path}[${index}]`, errors));
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const requiredKey of schema.required ?? []) {
      if (!(requiredKey in value)) {
        errors.push(`${path}: missing required property "${requiredKey}"`);
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value) validateNode(propertySchema, value[key], `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }
}

export function validateAgainstSchema(schema, value) {
  const errors = [];
  validateNode(schema, value, "$", errors);
  return { valid: errors.length === 0, errors };
}
