import { beforeEach, describe, expect, it } from "vitest";
import {
  COLUMN_ORDER_STORAGE_KEY,
  COHORTS_UI_SETTINGS_UPDATED_AT_KEY,
  buildCohortsUiSettingsPayload,
  newerCohortsUiSettings,
  readLocalCohortsUiSettings,
  sanitizeColumnOrder,
  writeLocalCohortsUiSettings,
  type CohortsUiSettingsDefaults,
} from "@/services/cohortsUiSettings";

const defaults: CohortsUiSettingsDefaults = {
  defaultColumnOrder: ["cohort_date", "campaign_path", "trial_users", "net_revenue"],
  defaultColumnWidths: {
    __cohort__: 150,
    cohort_date: 120,
    campaign_path: 160,
    trial_users: 90,
    net_revenue: 100,
  },
  defaultColumnVisibility: {
    cohort_date: true,
    campaign_path: true,
    trial_users: true,
    net_revenue: true,
  },
  defaultFilters: {
    campaignPathFilter: "all",
    cohortDateFrom: "",
  },
  validWidthKeys: ["__cohort__", "cohort_date", "campaign_path", "trial_users", "net_revenue"],
};

describe("cohorts UI settings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("applies saved order after reload from localStorage", () => {
    const payload = buildCohortsUiSettingsPayload(
      {
        columnOrder: ["net_revenue", "campaign_path", "cohort_date", "trial_users"],
        columnWidths: { net_revenue: 140 },
        columnVisibility: { net_revenue: true, campaign_path: false, cohort_date: true, trial_users: true },
        selectedView: "revenue",
        filters: { campaignPathFilter: "soulmate-reading" },
        updatedAt: "2026-05-09T10:00:00.000Z",
      },
      defaults,
    );

    writeLocalCohortsUiSettings(payload);
    const loaded = readLocalCohortsUiSettings(defaults);

    expect(loaded?.columnOrder).toEqual(["net_revenue", "campaign_path", "cohort_date", "trial_users"]);
    expect(loaded?.columnVisibility.campaign_path).toBe(false);
    expect(loaded?.filters.campaignPathFilter).toBe("soulmate-reading");
    expect(loaded?.selectedView).toBe("revenue");
  });

  it("uses cloud settings when local storage is empty", () => {
    const cloud = buildCohortsUiSettingsPayload(
      {
        columnOrder: ["trial_users", "net_revenue", "cohort_date", "campaign_path"],
        columnWidths: {},
        columnVisibility: {},
        selectedView: null,
        filters: {},
        updatedAt: "2026-05-09T11:00:00.000Z",
      },
      defaults,
    );

    expect(readLocalCohortsUiSettings(defaults)).toBeNull();
    expect(newerCohortsUiSettings(null, cloud)).toBe("cloud");
  });

  it("ignores unknown column IDs", () => {
    expect(sanitizeColumnOrder(["unknown", "net_revenue", "campaign_path"], defaults.defaultColumnOrder)).toEqual([
      "net_revenue",
      "campaign_path",
      "cohort_date",
      "trial_users",
    ]);
  });

  it("appends missing new columns", () => {
    expect(sanitizeColumnOrder(["campaign_path"], defaults.defaultColumnOrder)).toEqual([
      "campaign_path",
      "cohort_date",
      "trial_users",
      "net_revenue",
    ]);
  });

  it("removes duplicate column IDs", () => {
    expect(sanitizeColumnOrder(["net_revenue", "net_revenue", "trial_users"], defaults.defaultColumnOrder)).toEqual([
      "net_revenue",
      "trial_users",
      "cohort_date",
      "campaign_path",
    ]);
  });

  it("does not treat local defaults as newer without a settings timestamp", () => {
    localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(["net_revenue", "campaign_path"]));

    expect(localStorage.getItem(COHORTS_UI_SETTINGS_UPDATED_AT_KEY)).toBeNull();
    expect(readLocalCohortsUiSettings(defaults)).toBeNull();
  });
});
