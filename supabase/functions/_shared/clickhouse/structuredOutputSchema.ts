// Structured-output schema sanitizer.
//
// The Anthropic structured-outputs API accepts a restricted JSON-Schema subset:
// types, enum/const, anyOf/allOf/$ref, string formats and
// additionalProperties:false. Size/range constraints are REJECTED with a 400
// ("For 'array' type, property 'maxItems' is not supported") — which is exactly
// what took the assistant down the moment the API balance stopped masking it.
// The official Python/TS SDK helpers strip these keywords client-side and
// validate locally; our Deno edge path calls messages.create directly, so this
// module is that same strip applied at our single SDK boundary
// (_shared/anthropic.ts). Schema builders keep their caps as documentation and
// enforce them post-parse in their validators, not in the wire schema.

const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "minProperties",
  "maxProperties",
]);

// Values under these keys are MAPS whose keys are property names, not schema
// keywords — a property legitimately named "maxLength" must survive.
const PROPERTY_MAP_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeNode);
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) continue;
    if (PROPERTY_MAP_KEYS.has(key) && isRecord(value)) {
      const map: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        map[propName] = sanitizeNode(propSchema);
      }
      out[key] = map;
      continue;
    }
    out[key] = sanitizeNode(value);
  }
  return out;
}

/** Returns a deep copy of the schema with every keyword the structured-outputs
 * API rejects removed. Never mutates the input. */
export function stripUnsupportedSchemaKeywords(schema: Record<string, unknown>): Record<string, unknown> {
  return sanitizeNode(schema) as Record<string, unknown>;
}
