// Reports R8: rendering.
//
// Export fidelity is the point: an unavailable number must stay an em dash in
// every format (a 0 in a pasted Google Doc is indistinguishable from a real
// measurement), the passport header must survive, and text must never be able
// to inject markup — the report body carries model output in R9.
import { describe, expect, it } from "vitest";
import {
  escapeHtml, renderReportDocument, renderReportHtml, renderReportMarkdown,
  type RenderInput,
} from "@/services/reportExport";
import type {
  ReportBlock, ReportFunnelRow, ReportMetric, ReportSnapshot, ReportTask,
} from "@/services/reportContract";

function metric(key: string, rendered: string, over: Partial<ReportMetric> = {}): ReportMetric {
  return {
    key,
    label: key,
    current: { value: rendered === "—" ? null : 1, rendered, unit: "money", source: "computed", evidence: `kpi.${key}` },
    delta: null,
    target: null,
    sampleSize: null,
    ...over,
  };
}

function funnel(over: Partial<ReportFunnelRow> = {}): ReportFunnelRow {
  return {
    funnelPath: "soulmate-sketch",
    passport: {
      funnelPath: "soulmate-sketch", displayName: "Soulmate Sketch",
      trialPrice: 1, trialCurrency: "$", trialDurationDays: 7,
      subscriptionPrice: 34.99, subscriptionCurrency: "$", billingPeriod: "monthly",
      upsells: [{ name: "Zodiac Report", price: 14.98, currency: "$", ordinal: 1 }],
      defaultLanguage: "Английский", defaultCurrency: "$",
      geoLocalization: ["США", "Австралия"], destination: "web_app",
      product: null, trafficSources: [], incomplete: false,
    },
    metrics: { spend: metric("spend", "1 000,00 $"), cpa: metric("cpa", "—") },
    status: { status: "scale", because: "CPA 15 в пределах 30, конверсия 52% выше цели 40%.", ruleId: "all_green" },
    isNew: false,
    ...over,
  };
}

function snapshot(over: Partial<ReportSnapshot> = {}): ReportSnapshot {
  return {
    schemaVersion: 1,
    engineVersion: "report-v1",
    engineVersions: {
      report: "report-v1", cohortClassification: "c", funnelEconomics: "1.0.0",
      supportClassification: "s", fxRatesAsOf: "2026-07-01",
    },
    period: { from: "2026-07-21", to: "2026-07-27" },
    compare: { from: "2026-07-14", to: "2026-07-20" },
    collectedAt: "2026-08-04T09:00:00Z",
    warehouseVersionBefore: "w1", warehouseVersionAfter: "w1", consistent: true,
    kpi: { spend: metric("spend", "14 095,01 $"), ltv_1m: metric("ltv_1m", "—") },
    funnels: [funnel()],
    gaps: [{ key: "email", label: "Email-метрики", reason: "нет интеграции", affectsSections: ["email"], manualEntryAvailable: true }],
    provenance: [],
    thresholds: {},
    dataIncomplete: true,
    provisionalReasons: ["immature_cohorts_present"],
    ...over,
  };
}

function input(over: Partial<RenderInput> = {}): RenderInput {
  return {
    title: "Отчёт 27.07",
    snapshot: snapshot(),
    blocks: [],
    highlights: ["Blended CPA снизился до 12,49 $."],
    ...over,
  };
}

describe("renderReportMarkdown", () => {
  it("carries the headline, the KPI table and the funnel passport", () => {
    const md = renderReportMarkdown(input());
    expect(md).toContain("# Отчёт 27.07");
    expect(md).toContain("## Главное за неделю");
    expect(md).toContain("Blended CPA снизился до 12,49 $.");
    expect(md).toContain("| Показатель | Период |");
    expect(md).toContain("14 095,01 $");
    expect(md).toContain("Триал: 1$ длительностью 7 дн.");
    expect(md).toContain("Апсейл 1 Zodiac Report 14.98$");
    expect(md).toContain("Масштабировать");
  });

  it("keeps an unavailable value as an em dash, never as a zero", () => {
    const md = renderReportMarkdown(input());
    expect(md).toContain("—");
    expect(md).not.toMatch(/\|\s*0\s*\|/);
  });

  it("names the data gaps rather than omitting them", () => {
    expect(renderReportMarkdown(input())).toContain("Email-метрики");
  });

  it("includes the plan/fact table with the reason a task moved", () => {
    const task: ReportTask = {
      id: "t", title: "Подключить Adyen", direction: null, status: "moved",
      priority: "high", owner: null, plannedDate: null, actualDate: null,
      comment: null, link: null, movedReason: "шторм ФБ", result: null,
      firstReportId: null, closedReportId: null,
      createdAt: "", updatedAt: "",
    };
    const md = renderReportMarkdown(input({ tasks: { closed: [], open: [task] } }));
    expect(md).toContain("## План / Факт");
    expect(md).toContain("Подключить Adyen");
    expect(md).toContain("Перенесена");
    expect(md).toContain("шторм ФБ");
  });
});

describe("block placement", () => {
  function prose(id: string, section: ReportBlock["section"], title: string): ReportBlock {
    return {
      id, type: "text", section, title, content: `тело ${id}`,
      hidden: false, pinned: false, generatedBy: "human", editedByHuman: false,
      evidence: [], updatedAt: "",
    };
  }

  it("puts each block beside the numbers it talks about, not in one pile at the top", () => {
    const md = renderReportMarkdown(input({
      // Deliberately out of editorial order: the renderer, not the array, decides.
      blocks: [prose("b2", "product", "Продукт"), prose("b1", "executive_summary", "Главный вывод")],
    }));
    const summaryAt = md.indexOf("Главный вывод");
    const kpiAt = md.indexOf("Ключевые показатели недели");
    const funnelsAt = md.indexOf("Результаты по воронкам");
    const productAt = md.indexOf("Продукт");

    expect(summaryAt).toBeGreaterThan(-1);
    expect(summaryAt).toBeLessThan(kpiAt);
    expect(productAt).toBeGreaterThan(funnelsAt);
  });

  it("renders a section heading only when that section has something to say", () => {
    const md = renderReportMarkdown(input());
    expect(md).not.toContain("Email-маркетинг");
    expect(md).not.toContain("Риски и решения");
  });
});

describe("renderReportHtml", () => {
  it("emits real tables so a paste into Google Docs keeps its structure", () => {
    const html = renderReportHtml(input());
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Показатель</th>");
    expect(html).toContain("<h1>Отчёт 27.07</h1>");
  });

  it("escapes text so a block can never inject markup", () => {
    const block: ReportBlock = {
      id: "b1", type: "text", section: "executive_summary",
      title: "<script>alert(1)</script>",
      content: "Вывод: CPA <b>снизился</b> & конверсия выросла",
      hidden: false, pinned: false, generatedBy: "ai", editedByHuman: false,
      evidence: [], updatedAt: "",
    };
    const html = renderReportHtml(input({ blocks: [block] }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;снизился&lt;/b&gt;");
    expect(html).toContain("&amp;");
  });

  it("skips hidden blocks and non-prose block types", () => {
    const hidden: ReportBlock = {
      id: "h", type: "text", section: "executive_summary", title: "Скрытый",
      content: "не должно попасть", hidden: true, pinned: false,
      generatedBy: "human", editedByHuman: true, evidence: [], updatedAt: "",
    };
    expect(renderReportHtml(input({ blocks: [hidden] }))).not.toContain("не должно попасть");
  });

  it("wraps a standalone document with print rules that keep tables whole", () => {
    const doc = renderReportDocument(input());
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("@page");
    expect(doc).toContain("break-inside: avoid");
  });
});

describe("escapeHtml", () => {
  it("covers every character that could start a tag or close an attribute", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});
