// P9: project column prefs ride the SAME pure sanitizers as Cohorts, under
// project-local storage keys.
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadProjectColumnPrefs,
  persistProjectColumnPrefs,
  PROJECT_COLUMN_ORDER,
} from "@/components/forecasting/projectTableColumns";

describe("project column prefs", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to every column visible and no active view", () => {
    const prefs = loadProjectColumnPrefs();
    expect(PROJECT_COLUMN_ORDER.every((id) => prefs.visibility[id] === true)).toBe(true);
    expect(prefs.savedViews).toEqual([]);
    expect(prefs.activeViewId).toBeNull();
  });

  it("round-trips visibility and views; unknown columns are dropped by the sanitizer", () => {
    persistProjectColumnPrefs({
      visibility: { spend: false, bogus_column: true } as Record<string, boolean>,
      savedViews: [{ id: "v1", name: "Lean", columnOrder: PROJECT_COLUMN_ORDER, columnVisibility: { gross: false, contribution: false } }],
      activeViewId: null,
    });
    const prefs = loadProjectColumnPrefs();
    expect(prefs.visibility.bogus_column).toBeUndefined();
    // The landing rule kicked in: with no explicit choice the newest saved view
    // lands AND applies its visibility — label and columns agree.
    expect(prefs.activeViewId).toBe("v1");
    expect(prefs.visibility.gross).toBe(false);
    expect(prefs.visibility.contribution).toBe(false);
    expect(prefs.visibility.trials).toBe(true);
  });

  it("an explicit active view wins over the newest and applies its columns", () => {
    persistProjectColumnPrefs({
      visibility: {},
      savedViews: [
        { id: "older", name: "Older", columnOrder: PROJECT_COLUMN_ORDER, columnVisibility: { payback: false } },
        { id: "newer", name: "Newer", columnOrder: PROJECT_COLUMN_ORDER, columnVisibility: { spend: false } },
      ],
      activeViewId: "older",
    });
    const prefs = loadProjectColumnPrefs();
    expect(prefs.activeViewId).toBe("older");
    expect(prefs.visibility.payback).toBe(false);
    expect(prefs.visibility.spend).toBe(true);
  });

  it("a stale active id falls back to the landing rule instead of crashing", () => {
    persistProjectColumnPrefs({
      visibility: {},
      savedViews: [{ id: "v1", name: "Only", columnOrder: PROJECT_COLUMN_ORDER, columnVisibility: {} }],
      activeViewId: "deleted-view",
    });
    localStorage.setItem("project_forecast_active_view_v1", "deleted-view");
    const prefs = loadProjectColumnPrefs();
    expect(prefs.activeViewId).toBe("v1");
  });
});
