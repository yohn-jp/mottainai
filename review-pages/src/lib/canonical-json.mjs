// Deterministic JSON serialization: object keys sorted by Unicode code
// point, arrays keep caller-supplied order, no insignificant whitespace
// beyond the fixed 2-space indent. Equivalent inputs always produce
// byte-identical output.

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      const child = sortValue(value[key]);
      if (child !== undefined) sorted[key] = child;
    }
    return sorted;
  }
  return value;
}

export function canonicalize(value) {
  return sortValue(value);
}

export function canonicalStringify(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}
