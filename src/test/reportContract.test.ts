// Reports R1: the pure contract logic — target resolution, task carry-over and
// the schema gate. These three decide whether a past report can still be read
// and judged the way it was written, so they are tested before anything renders.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPORT_SECTIONS,
  emptyReportBindings,
  isOpenTaskStatus,
  REPORT_SCHEMA_VERSION,
  resolveTarget,
  type ReportTarget,
} from "@/services/reportContract";
import { openReportVersion, type ReportVersion } from "@/services/reports";
import { partitionTasksForPeriod } from "@/services/reportWorkItems";
import type { ReportTask } from "@/services/reportContract";

function target(over: Partial<ReportTarget> = {}): ReportTarget {
  return {
    id: "t1",
    metricKey: "cpa",
    scopeKind: "global",
    scopeValue: null,
    targetValue: 30,
    comparator: "lte",
    effectiveFrom: "2026-06-01",
    effectiveTo: null,
    note: null,
    createdAt: "2026-06-01T00:00:00Z",
    ...over,
  };
}

function task(over: Partial<ReportTask> = {}): ReportTask {
  return {
    id: "task-1",
    title: "Подключить Adyen",
    direction: null,
    status: "planned",
    priority: "high",
    owner: null,
    plannedDate: "2026-07-21",
    actualDate: null,
    comment: null,
    link: null,
    movedReason: null,
    result: null,
    firstReportId: null,
    closedReportId: null,
    createdAt: "2026-07-21T00:00:00Z",
    updatedAt: "2026-07-21T00:00:00Z",
    ...over,
  };
}

describe("resolveTarget", () => {
  it("prefers the most specific scope: funnel beats geo beats channel beats global", () => {
    const targets = [
      target({ id: "g", scopeKind: "global", targetValue: 30 }),
      target({ id: "geo", scopeKind: "geo", scopeValue: "CO", targetValue: 20 }),
      target({ id: "f", scopeKind: "funnel", scopeValue: "soulmate-sketch", targetValue: 15 }),
    ];
    const hit = resolveTarget(targets, "cpa", "2026-07-20", { funnel: "soulmate-sketch", geo: "CO" });
    expect(hit?.id).toBe("f");
    expect(resolveTarget(targets, "cpa", "2026-07-20", { geo: "CO" })?.id).toBe("geo");
    expect(resolveTarget(targets, "cpa", "2026-07-20", {})?.id).toBe("g");
  });

  it("respects effective dating — a July report is judged by July's ceiling", () => {
    const targets = [
      target({ id: "old", targetValue: 30, effectiveFrom: "2026-06-01", effectiveTo: "2026-07-14" }),
      target({ id: "new", targetValue: 20, effectiveFrom: "2026-07-15", effectiveTo: null }),
    ];
    expect(resolveTarget(targets, "cpa", "2026-07-10")?.targetValue).toBe(30);
    expect(resolveTarget(targets, "cpa", "2026-07-20")?.targetValue).toBe(20);
  });

  it("returns null rather than a wrong target when nothing applies", () => {
    expect(resolveTarget([target({ effectiveFrom: "2026-08-01" })], "cpa", "2026-07-20")).toBeNull();
    expect(resolveTarget([target()], "upsell_cr", "2026-07-20")).toBeNull();
  });

  it("breaks ties inside a scope by the newest effective_from", () => {
    const targets = [
      target({ id: "a", targetValue: 30, effectiveFrom: "2026-06-01" }),
      target({ id: "b", targetValue: 25, effectiveFrom: "2026-07-01" }),
    ];
    expect(resolveTarget(targets, "cpa", "2026-07-20")?.id).toBe("b");
  });
});

describe("partitionTasksForPeriod", () => {
  const period = { from: "2026-07-21", to: "2026-07-27" };

  it("carries every open task forward regardless of when it was planned", () => {
    const tasks = [
      task({ id: "planned", status: "planned", plannedDate: "2026-06-01" }),
      task({ id: "moved", status: "moved", movedReason: "шторм ФБ" }),
      task({ id: "blocked", status: "blocked" }),
    ];
    const { open, closed } = partitionTasksForPeriod(tasks, period);
    expect(open.map((t) => t.id).sort()).toEqual(["blocked", "moved", "planned"]);
    expect(closed).toEqual([]);
  });

  it("counts a task as done this week only when it closed inside the window", () => {
    const tasks = [
      task({ id: "this-week", status: "done", actualDate: "2026-07-24" }),
      task({ id: "weeks-ago", status: "done", actualDate: "2026-07-02" }),
      task({ id: "no-date", status: "done", actualDate: null }),
    ];
    const { closed } = partitionTasksForPeriod(tasks, period);
    expect(closed.map((t) => t.id)).toEqual(["this-week"]);
  });

  it("agrees with isOpenTaskStatus about what stays in play", () => {
    expect(isOpenTaskStatus("planned")).toBe(true);
    expect(isOpenTaskStatus("moved")).toBe(true);
    expect(isOpenTaskStatus("done")).toBe(false);
    expect(isOpenTaskStatus("cancelled")).toBe(false);
  });
});

describe("openReportVersion", () => {
  function version(over: Partial<ReportVersion> = {}): ReportVersion {
    return {
      id: "v1",
      reportId: "r1",
      versionNo: 1,
      title: "Отчёт 27.07",
      period: { from: "2026-07-21", to: "2026-07-27" },
      schemaVersion: REPORT_SCHEMA_VERSION,
      engineVersion: "report-v1",
      engineVersions: {
        report: "report-v1",
        cohortClassification: "cohort_classifier_v3_platform",
        funnelEconomics: "1.0.0",
        supportClassification: "support_llm_v2",
        fxRatesAsOf: "2026-07-01",
      },
      bindings: emptyReportBindings({ from: "2026-07-21", to: "2026-07-27" }, null),
      manualInputs: {},
      snapshot: {} as ReportVersion["snapshot"],
      blocks: [],
      publishedAt: "2026-07-28T09:00:00Z",
      ...over,
    };
  }

  it("opens a current-schema version normally", () => {
    expect(openReportVersion(version()).kind).toBe("ok");
  });

  it("degrades an older schema to archived instead of throwing or restating it", () => {
    const opened = openReportVersion(version({ schemaVersion: REPORT_SCHEMA_VERSION - 1 }));
    expect(opened.kind).toBe("archived");
    if (opened.kind === "archived") {
      expect(opened.reason).toContain("без пересчёта");
      // The payload is still handed back — an archived report stays readable.
      expect(opened.version.title).toBe("Отчёт 27.07");
    }
  });
});

describe("emptyReportBindings", () => {
  it("starts on the MVP section set and copies it, so editing one report never moves the default", () => {
    const bindings = emptyReportBindings({ from: "2026-07-21", to: "2026-07-27" }, null);
    expect(bindings.sections).toEqual([...DEFAULT_REPORT_SECTIONS]);
    bindings.sections.push("risks_decisions");
    expect(DEFAULT_REPORT_SECTIONS).not.toContain("risks_decisions");
  });
});
