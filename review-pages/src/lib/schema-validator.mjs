// Minimal JSON Schema (draft-07 subset) validator: type, required,
// properties, additionalProperties, items, enum, pattern, numeric and
// collection/string bounds. This
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

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: must contain at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: must contain at most ${schema.maxLength} characters`);
    }
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      errors.push(`${path}: must be a finite number`);
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: must contain at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: must contain at most ${schema.maxItems} items`);
    }
    if (schema.uniqueItems === true) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) {
        errors.push(`${path}: must contain unique items`);
      }
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => validateNode(schema.items, item, `${path}[${index}]`, errors));
    }
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
