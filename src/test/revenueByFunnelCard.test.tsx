import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { RevenueByFunnelCard } from "@/components/RevenueByFunnelCard";
import { buildFunnelListView, FUNNEL_TOP_N } from "@/services/revenueFunnelList";
import type { RevenueSliceRow } from "@/services/revenueIntelligence";

// Dashboard "Revenue by funnel": the top funnels by the sorted column, the long
// tail folded into one Other row until expanded, Unknown / Unattributed pinned
// below the funnels — and the rows on screen always add up to the totals.

function funnel(key: string, gross: number, gross_new = gross / 4): RevenueSliceRow {
  return { key, gross, net: gross - 1, gross_new, gross_existing: gross - gross_new };
}

const FUNNELS = Array.from({ length: 12 }, (_, i) => funnel(`funnel-${String(i + 1).padStart(2, "0")}`, 1_000 - i * 50));
const ROWS: RevenueSliceRow[] = [
  ...FUNNELS,
  { key: "Unknown", gross: 30, net: 30, gross_new: 10, gross_existing: 20 },
  { key: "Unattributed", gross: 20, net: 20, gross_new: 0, gross_existing: 0 },
];
const sum = (rows: ReadonlyArray<RevenueSliceRow>, field: "gross" | "net") => rows.reduce((total, row) => total + row[field], 0);
const TOTALS = { gross: sum(ROWS, "gross"), net: sum(ROWS, "net"), gross_new: 0, gross_existing: 0 };

describe("buildFunnelListView", () => {
  it("shows the top N by gross, folds the tail into Other and pins Unknown / Unattributed", () => {
    const view = buildFunnelListView(ROWS, { key: "gross", dir: "desc" }, false);
    expect(view.visible.map((row) => row.key)).toEqual(FUNNELS.slice(0, FUNNEL_TOP_N).map((row) => row.key));
    expect(view.other).toMatchObject({ key: "Other", count: 12 - FUNNEL_TOP_N });
    expect(view.pinned.map((row) => row.key)).toEqual(["Unknown", "Unattributed"]);
    expect(view.funnelCount).toBe(12);
    // Nothing is lost by folding.
    const onScreen = [...view.visible, view.other!, ...view.pinned];
    expect(sum(onScreen, "gross")).toBe(TOTALS.gross);
    expect(sum(onScreen, "net")).toBe(TOTALS.net);
    expect(view.maxGross).toBe(Math.max(1_000, view.other!.gross));
  });

  it("expanded shows every funnel; a tail of one funnel is never folded", () => {
    expect(buildFunnelListView(ROWS, { key: "gross", dir: "desc" }, true)).toMatchObject({ other: null });
    expect(buildFunnelListView(ROWS, { key: "gross", dir: "desc" }, true).visible).toHaveLength(12);
    const nine = buildFunnelListView(FUNNELS.slice(0, FUNNEL_TOP_N + 1), { key: "gross", dir: "desc" }, false);
    expect(nine.other).toBeNull();
    expect(nine.visible).toHaveLength(FUNNEL_TOP_N + 1);
  });

  it("sorts by the chosen column, and the pinned rows stay last in any order", () => {
    const asc = buildFunnelListView(ROWS, { key: "gross", dir: "asc" }, true);
    expect(asc.visible[0].key).toBe("funnel-12");
    expect(asc.pinned.map((row) => row.key)).toEqual(["Unknown", "Unattributed"]);
    const byName = buildFunnelListView(ROWS, { key: "key", dir: "desc" }, false);
    expect(byName.visible[0].key).toBe("funnel-12");
  });
});

describe("RevenueByFunnelCard", () => {
  it("renders the folded list with totals and expands on demand", () => {
    render(<RevenueByFunnelCard rows={ROWS} totals={TOTALS} footer="Attribution coverage 99%" />);
    const card = screen.getByTestId("revenue-by-funnel");
    expect(within(card).getByText("12 funnels · period · same funnel identity as Cohorts")).toBeInTheDocument();
    expect(within(card).getByText("funnel-01")).toBeInTheDocument();
    expect(within(card).queryByText("funnel-12")).toBeNull();
    expect(within(card).getByText(`· ${12 - FUNNEL_TOP_N} funnels`)).toBeInTheDocument();
    expect(within(card).getByText("Attribution coverage 99%")).toBeInTheDocument();
    // Whole dollars, no cents.
    expect(within(card).getByText("$1,000")).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "Show all 12 funnels" }));
    expect(within(card).getByText("funnel-12")).toBeInTheDocument();
    expect(within(card).queryByText(`· ${12 - FUNNEL_TOP_N} funnels`)).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: `Show top ${FUNNEL_TOP_N}` }));
    expect(within(card).queryByText("funnel-12")).toBeNull();
  });

  it("re-sorts when a column header is clicked", () => {
    render(<RevenueByFunnelCard rows={ROWS} totals={TOTALS} />);
    const card = screen.getByTestId("revenue-by-funnel");
    fireEvent.click(within(card).getByRole("columnheader", { name: /^Gross/ }));
    const firstRow = within(card).getAllByRole("row")[1];
    expect(within(firstRow).getByText("funnel-12")).toBeInTheDocument();
  });
});
