import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLUMN_ORDER_STORAGE_KEY,
  COHORTS_UI_SETTINGS_UPDATED_AT_KEY,
  buildCohortsUiSettingsPayload,
  loadCohortsUiSettingsCloud,
  loadCohortsUiSettingsLocal,
  mergeCohortsUiSettings,
  newerCohortsUiSettings,
  saveCohortsUiSettingsCloud,
  saveCohortsUiSettingsLocal,
  sanitizeColumnOrder,
  type CohortsUiSettingsDefaults,
} from "@/services/cohortsUiSettings";
import {
  loadLatestCloudSnapshot,
  saveCloudSnapshot,
} from "@/services/dataSnapshots";

vi.mock("@/services/dataSnapshots", () => ({
  saveCloudSnapshot: vi.fn(async ({ payload }) => ({
    id: "snapshot_1",
    dataset_type: "cohorts_ui_settings",
    name: "Cohorts UI settings",
    payload,
    metadata: {},
    created_at: "2026-05-09T00:00:00.000Z",
    updated_at: "2026-05-09T00:00:00.000Z",
  })),
  loadLatestCloudSnapshot: vi.fn(),
}));

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
  validSelectedViewIds: ["default", "revenue"],
  defaultSelectedView: "default",
};

describe("cohorts UI settings", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("applies saved order after reload from localStorage", () => {
    const payload = buildCohortsUiSettingsPayload(
      {
        columnOrder: ["net_revenue", "campaign_path", "cohort_date", "trial_users"],
        columnWidths: { net_revenue: 140 },
        columnVisibility: { net_revenue: true, campaign_path: false, cohort_date: true, trial_users: true },
        selectedView: "revenue",
        savedViews: [],
        filters: { campaignPathFilter: "soulmate-reading" },
        updatedAt: "2026-05-09T10:00:00.000Z",
      },
      defaults,
    );

    saveCohortsUiSettingsLocal(payload);
    const loaded = loadCohortsUiSettingsLocal(defaults);

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
        savedViews: [],
        filters: {},
        updatedAt: "2026-05-09T11:00:00.000Z",
      },
      defaults,
    );

    expect(loadCohortsUiSettingsLocal(defaults)).toBeNull();
    expect(newerCohortsUiSettings(null, cloud)).toBe("cloud");
  });

  it("saves and loads cloud settings through the snapshot service", async () => {
    const payload = buildCohortsUiSettingsPayload(
      {
        columnOrder: ["trial_users", "net_revenue", "cohort_date", "campaign_path"],
        columnWidths: { trial_users: 130 },
        columnVisibility: { net_revenue: false },
        selectedView: "default",
        savedViews: [],
        filters: {},
        updatedAt: "2026-05-09T12:00:00.000Z",
      },
      defaults,
    );
    vi.mocked(loadLatestCloudSnapshot).mockResolvedValue({
      id: "snapshot_1",
      dataset_type: "cohorts_ui_settings",
      name: "Cohorts UI settings",
      payload,
      metadata: {},
      created_at: "2026-05-09T12:00:00.000Z",
      updated_at: "2026-05-09T12:00:00.000Z",
    });

    await saveCohortsUiSettingsCloud(payload);
    const loaded = await loadCohortsUiSettingsCloud(defaults);

    expect(saveCloudSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      datasetType: "cohorts_ui_settings",
      payload,
    }));
    expect(loaded?.columnOrder[0]).toBe("trial_users");
    expect(loaded?.columnVisibility.net_revenue).toBe(false);
  });

  it("cloud settings win when local storage is empty", () => {
    const cloud = buildCohortsUiSettingsPayload(
      {
        columnOrder: ["trial_users"],
        columnWidths: {},
        columnVisibility: {},
        selectedView: null,
        savedViews: [],
        filters: {},
        updatedAt: "2026-05-09T12:00:00.000Z",
      },
      defaults,
    );

    expect(mergeCohortsUiSettings(null, cloud)).toEqual({ source: "cloud", settings: cloud });
  });

  it("newer updatedAt wins", () => {
    const older = buildCohortsUiSettingsPayload(
      {
        columnOrder: ["cohort_date"],
        columnWidths: {},
        columnVisibility: {},
        selectedView: null,
        savedViews: [],
        filters: {},
        updatedAt: "2026-05-09T10:00:00.000Z",
      },
      defaults,
    );
    const newer = buildCohortsUiSettingsPayload(
      {
        columnOrder: ["net_revenue"],
        columnWidths: {},
        columnVisibility: {},
        selectedView: null,
        savedViews: [],
        filters: {},
        updatedAt: "2026-05-09T11:00:00.000Z",
      },
      defaults,
    );

    expect(mergeCohortsUiSettings(older, newer)).toEqual({ source: "cloud", settings: newer });
    expect(mergeCohortsUiSettings(newer, older)).toEqual({ source: "local", settings: newer });
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
    expect(loadCohortsUiSettingsLocal(defaults)).toBeNull();
  });

  it("restores custom saved views", () => {
    const payload = buildCohortsUiSettingsPayload(
      {
        columnOrder: ["cohort_date"],
        columnWidths: {},
        columnVisibility: {},
        selectedView: "custom_revenue",
        savedViews: [
          {
            id: "custom_revenue",
            name: "My Revenue",
            columnOrder: ["net_revenue", "campaign_path"],
            columnVisibility: { net_revenue: true, campaign_path: true },
            columnWidths: { net_revenue: 150 },
          },
        ],
        filters: {},
        updatedAt: "2026-05-09T12:00:00.000Z",
      },
      defaults,
    );

    expect(payload.selectedView).toBe("custom_revenue");
    expect(payload.savedViews).toHaveLength(1);
    expect(payload.savedViews[0].columnOrder).toEqual([
      "net_revenue",
      "campaign_path",
      "cohort_date",
      "trial_users",
    ]);
  });
});
