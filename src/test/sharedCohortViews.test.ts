import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultSharedViewForRole,
  isSharedViewId,
  markRoleDefaultApplied,
  roleDefaultApplied,
  sharedViewFromRow,
  type SharedCohortView,
} from "@/services/sharedCohortViews";

function view(rowId: string, defaultRoleKeys: string[], updatedAt: string): SharedCohortView {
  return sharedViewFromRow({
    id: rowId,
    name: `View ${rowId}`,
    column_order: ["trial_users"],
    column_visibility: { trial_users: true },
    column_widths: null,
    default_role_keys: defaultRoleKeys,
    updated_at: updatedAt,
  })!;
}

describe("shared Cohorts views (browser)", () => {
  beforeEach(() => localStorage.clear());

  it("maps rows, dropping malformed values", () => {
    const parsed = sharedViewFromRow({
      id: "row-1",
      name: " Buyer ",
      column_order: ["trial_users", 7, "gross_revenue"],
      column_visibility: { trial_users: true, gross_revenue: "yes" },
      column_widths: { trial_users: 120, gross_revenue: -1 },
      default_role_keys: ["media_buyer", "", null, "media_buyer", "head_of_marketing"],
      updated_at: "2026-10-18T10:00:00Z",
    });
    expect(parsed).toEqual({
      id: "shared:row-1",
      rowId: "row-1",
      name: "Buyer",
      columnOrder: ["trial_users", "gross_revenue"],
      columnVisibility: { trial_users: true },
      columnWidths: { trial_users: 120 },
      defaultRoleKeys: ["head_of_marketing", "media_buyer"],
      updatedAt: "2026-10-18T10:00:00Z",
    });
    expect(sharedViewFromRow({ id: "", name: "x" })).toBeNull();
    expect(isSharedViewId(parsed!.id)).toBe(true);
    expect(isSharedViewId("custom_1")).toBe(false);
    expect(isSharedViewId(null)).toBe(false);
  });

  it("picks the most recently updated view naming the role", () => {
    const views = [
      view("a", ["media_buyer"], "2026-10-18T10:00:00Z"),
      view("b", ["media_buyer", "head_of_marketing"], "2026-10-18T11:00:00Z"),
      view("c", ["analyst"], "2026-10-18T12:00:00Z"),
    ];
    expect(defaultSharedViewForRole(views, "media_buyer")?.rowId).toBe("b");
    expect(defaultSharedViewForRole(views, "head_of_marketing")?.rowId).toBe("b");
    expect(defaultSharedViewForRole(views, "viewer")).toBeNull();
    expect(defaultSharedViewForRole(views, null)).toBeNull();
  });

  it("remembers a landed default per member and view", () => {
    const buyer = view("b", ["media_buyer"], "2026-10-18T11:00:00Z");
    const other = view("c", ["media_buyer"], "2026-10-18T12:00:00Z");
    expect(roleDefaultApplied("user-1", buyer)).toBe(false);
    markRoleDefaultApplied("user-1", buyer);
    markRoleDefaultApplied("user-1", buyer);
    expect(roleDefaultApplied("user-1", buyer)).toBe(true);
    expect(roleDefaultApplied("USER-1", buyer)).toBe(true);
    expect(roleDefaultApplied("user-1", other)).toBe(false);
    expect(roleDefaultApplied("user-2", buyer)).toBe(false);
    expect(roleDefaultApplied(null, buyer)).toBe(false);
    markRoleDefaultApplied(null, buyer);
  });
});
