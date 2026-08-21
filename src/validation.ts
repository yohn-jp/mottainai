import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, coerceTypes: false });
const validatorCache = new Map<string, any>();

export interface ValidationOutcome {
  valid: boolean;
  error?: string;
}

export function validateToolArguments(
  toolName: string,
  schema: any,
  args: Record<string, any> | undefined
): ValidationOutcome {
  if (!schema) {
    return { valid: true };
  }

  let validate = validatorCache.get(toolName);
  if (!validate) {
    validate = ajv.compile(schema);
    validatorCache.set(toolName, validate);
  }

  const payload = args || {};
  const isValid = validate(payload);

  if (!isValid && validate.errors) {
    const errorDetails = validate.errors.map((err: any) => {
      if (err.keyword === "additionalProperties" && err.params?.additionalProperty) {
        return `unrecognized parameter '${err.params.additionalProperty}'`;
      }
      const path = err.instancePath ? err.instancePath.replace(/^\//, "") : "arguments";
      return `${path}${err.message}`;
    });

    return {
      valid: false,
      error: `Invalid parameters for '${toolName}':${errorDetails.join(", ")}`,
    };
  }

  return { valid: true };
}