// The structured-outputs API rejects size/range JSON-Schema keywords with a
// 400 (live failure 2026-08-24: "For 'array' type, property 'maxItems' is not
// supported" — masked until the API balance was topped up). This suite pins
// the boundary sanitizer and proves both production schemas survive it.
import { describe, expect, it } from "vitest";
import { stripUnsupportedSchemaKeywords } from "../../supabase/functions/_shared/clickhouse/structuredOutputSchema.ts";
import { buildAssistantSchema, type AssistantInput } from "../../supabase/functions/_shared/clickhouse/aiAssistant.ts";
import { buildNarrativeSchema } from "../../supabase/functions/_shared/clickhouse/reportNarrative.ts";

const UNSUPPORTED = [
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "contains",
  "minProperties", "maxProperties",
];

function findUnsupported(node: unknown, path = "$"): string[] {
  if (Array.isArray(node)) return node.flatMap((item, i) => findUnsupported(item, `${path}[${i}]`));
  if (!node || typeof node !== "object") return [];
  const hits: string[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED.includes(key)) hits.push(`${path}.${key}`);
    // Inside "properties" the keys are property names — only their VALUES are schemas.
    if (key === "properties" && value && typeof value === "object") {
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        hits.push(...findUnsupported(sub, `${path}.properties.${name}`));
      }
      continue;
    }
    hits.push(...findUnsupported(value, `${path}.${key}`));
  }
  return hits;
}

describe("stripUnsupportedSchemaKeywords", () => {
  it("removes rejected keywords at every depth and keeps the supported shape", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["list"],
      properties: {
        list: { type: "array", maxItems: 5, minItems: 1, items: { type: "string", maxLength: 80 } },
        nested: { anyOf: [{ type: "number", minimum: 0, maximum: 10 }, { type: "null" }] },
      },
    };
    const stripped = stripUnsupportedSchemaKeywords(schema);
    expect(findUnsupported(stripped)).toEqual([]);
    // The supported skeleton is intact.
    expect(stripped).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["list"],
      properties: {
        list: { type: "array", items: { type: "string" } },
        nested: { anyOf: [{ type: "number" }, { type: "null" }] },
      },
    });
  });

  it("never mutates the input schema", () => {
    const schema = { type: "array", maxItems: 3, items: { type: "string" } };
    const before = JSON.stringify(schema);
    stripUnsupportedSchemaKeywords(schema);
    expect(JSON.stringify(schema)).toBe(before);
  });

  it("keeps property NAMES that collide with keyword names", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        maxLength: { type: "integer" }, // a real field named maxLength
        maxItems: { type: "integer" },
      },
    };
    const stripped = stripUnsupportedSchemaKeywords(schema) as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(stripped.properties)).toEqual(["maxLength", "maxItems"]);
  });
});

describe("production schemas pass the boundary sanitizer", () => {
  it("assistant schema carries no unsupported keywords after stripping", () => {
    const input: AssistantInput = {
      question: "What should I scale?",
      surface: "campaign",
      contextPack: {
        engineVersion: "ai-signals-v1",
        asOfDate: "2026-08-24",
        items: [
          { scopeLabel: "Campaign A", action: "SCALE +20%", claim: "CPA $14.20", evidenceLines: ["CPA $14.20"], dataNotes: [] },
        ],
        inputStatusLines: [],
      },
      contextLabel: "FB Analytics · Jul 1–31 · 18 campaigns",
    };
    const raw = buildAssistantSchema(input);
    expect(findUnsupported(raw).length).toBeGreaterThan(0); // documentation caps stay in the builder
    expect(findUnsupported(stripUnsupportedSchemaKeywords(raw))).toEqual([]);
  });

  it("narrative schema carries no unsupported keywords after stripping", () => {
    const raw = buildNarrativeSchema({
      periodLabel: "Jul 1–31",
      kpi: [],
      funnels: [{ funnelPath: "soulmate", status: "scale", because: "", metrics: [] }],
      findings: [{ id: "f1", claim: "CPA moved", severity: "high", scope: "soulmate" }],
      gaps: [],
      thresholds: [],
      notes: [],
      tasks: { closed: [], open: [] },
    } as never);
    expect(findUnsupported(stripUnsupportedSchemaKeywords(raw))).toEqual([]);
  });
});
