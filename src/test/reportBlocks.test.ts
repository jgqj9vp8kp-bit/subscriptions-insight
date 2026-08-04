// Reports R6: the block model.
//
// The properties worth pinning are the ones that protect the operator's text:
// an edit never silently loses provenance, a reorder never crosses a section by
// accident, and a row written by an older version of the app still loads.
import { describe, expect, it } from "vitest";
import type { ReportBlock } from "@/services/reportContract";
import {
  addBlock, blocksInSection, MAX_BLOCK_CONTENT_CHARS, moveBlockWithinSection, newReportBlock,
  orderedBlocks, patchBlock, removeBlock, reorderBlock, sanitizeBlocks, SECTION_LABELS,
  usedSections,
} from "@/services/reportBlocks";

const NOW = "2026-08-04T10:00:00Z";
const LATER = "2026-08-04T11:00:00Z";

function block(id: string, over: Partial<ReportBlock> = {}): ReportBlock {
  return {
    ...newReportBlock({ id, section: "funnels", now: NOW }),
    ...over,
  };
}

describe("newReportBlock", () => {
  it("titles a new block after its section and marks it human-written", () => {
    const created = newReportBlock({ id: "b1", section: "executive_summary", now: NOW });
    expect(created.title).toBe(SECTION_LABELS.executive_summary);
    expect(created.generatedBy).toBe("human");
    expect(created.editedByHuman).toBe(false);
    expect(created.hidden).toBe(false);
    expect(created.pinned).toBe(false);
    expect(created.type).toBe("text");
  });
});

describe("patchBlock", () => {
  it("marks an AI block as human-edited once its prose changes", () => {
    const blocks = [block("b1", { generatedBy: "ai", content: "Модельный текст" })];
    const edited = patchBlock(blocks, "b1", { content: "Мой текст" }, LATER);
    expect(edited[0].editedByHuman).toBe(true);
    expect(edited[0].updatedAt).toBe(LATER);
  });

  it("does not call hiding or pinning an edit", () => {
    const blocks = [block("b1", { generatedBy: "ai" })];
    const hidden = patchBlock(blocks, "b1", { hidden: true }, LATER);
    expect(hidden[0].editedByHuman).toBe(false);
    expect(hidden[0].updatedAt).toBe(NOW);

    const pinned = patchBlock(hidden, "b1", { pinned: true }, LATER);
    expect(pinned[0].editedByHuman).toBe(false);
  });

  it("never un-marks a block a human has already edited", () => {
    const blocks = [block("b1", { generatedBy: "ai", editedByHuman: true })];
    expect(patchBlock(blocks, "b1", { hidden: true }, LATER)[0].editedByHuman).toBe(true);
  });

  it("clamps a paste that would blow up the stored row", () => {
    const blocks = [block("b1")];
    const long = "я".repeat(MAX_BLOCK_CONTENT_CHARS + 500);
    expect(patchBlock(blocks, "b1", { content: long }, LATER)[0].content.length)
      .toBe(MAX_BLOCK_CONTENT_CHARS);
  });

  it("leaves every other block alone", () => {
    const blocks = [block("b1"), block("b2", { content: "нетронуто" })];
    const next = patchBlock(blocks, "b1", { content: "новое" }, LATER);
    expect(next[1]).toBe(blocks[1]);
  });
});

describe("moveBlockWithinSection", () => {
  const blocks = [
    block("f1", { section: "funnels" }),
    block("e1", { section: "executive_summary" }),
    block("f2", { section: "funnels" }),
  ];

  it("swaps a block with its section-mate, not with whatever is adjacent", () => {
    const moved = moveBlockWithinSection(blocks, "f2", -1);
    expect(blocksInSection(moved, "funnels").map((b) => b.id)).toEqual(["f2", "f1"]);
    // The block from the other section stayed where it was.
    expect(moved.map((b) => b.id)).toEqual(["f2", "e1", "f1"]);
  });

  it("is a no-op at the edges, so a block cannot be pushed into another section", () => {
    expect(moveBlockWithinSection(blocks, "f1", -1).map((b) => b.id))
      .toEqual(["f1", "e1", "f2"]);
    expect(moveBlockWithinSection(blocks, "f2", 1).map((b) => b.id))
      .toEqual(["f1", "e1", "f2"]);
  });
});

describe("reorderBlock", () => {
  it("moves a dragged block to the drop target's place", () => {
    const blocks = [block("a"), block("b"), block("c")];
    expect(reorderBlock(blocks, "c", "a").map((b) => b.id)).toEqual(["c", "a", "b"]);
  });

  it("adopts the target's section — the one deliberate way to change section by drag", () => {
    const blocks = [
      block("a", { section: "executive_summary" }),
      block("b", { section: "funnels" }),
    ];
    const next = reorderBlock(blocks, "a", "b");
    expect(next.find((b) => b.id === "a")?.section).toBe("funnels");
  });
});

describe("orderedBlocks", () => {
  it("reads in editorial order regardless of the order they were added", () => {
    const blocks = [
      block("late", { section: "risks_decisions" }),
      block("early", { section: "highlights" }),
      block("mid", { section: "funnels" }),
    ];
    expect(orderedBlocks(blocks).map((b) => b.id)).toEqual(["early", "mid", "late"]);
  });

  it("keeps a block from an unknown section instead of dropping it", () => {
    const blocks = [
      block("unknown", { section: "retired_section" as ReportBlock["section"] }),
      block("known", { section: "kpi" }),
    ];
    expect(orderedBlocks(blocks).map((b) => b.id)).toEqual(["known", "unknown"]);
  });
});

describe("add / remove / usedSections", () => {
  it("adds, removes and reports only the sections that hold something", () => {
    let blocks: ReportBlock[] = [];
    blocks = addBlock(blocks, newReportBlock({ id: "b1", section: "kpi", now: NOW }));
    blocks = addBlock(blocks, newReportBlock({ id: "b2", section: "highlights", now: NOW }));
    expect(usedSections(blocks)).toEqual(["highlights", "kpi"]);

    blocks = removeBlock(blocks, "b2");
    expect(usedSections(blocks)).toEqual(["kpi"]);
  });
});

describe("sanitizeBlocks", () => {
  it("repairs a row written before a field existed rather than discarding it", () => {
    const [restored] = sanitizeBlocks([{ id: "b1", section: "funnels", content: "текст" }]);
    expect(restored.type).toBe("text");
    expect(restored.generatedBy).toBe("human");
    expect(restored.hidden).toBe(false);
    expect(restored.evidence).toEqual([]);
    expect(restored.content).toBe("текст");
  });

  it("drops entries that are not blocks at all, and duplicate ids", () => {
    const blocks = sanitizeBlocks([
      null, "строка", 42,
      { id: "b1", section: "kpi" },
      { id: "b1", section: "kpi", content: "дубль" },
      { section: "kpi" },
    ]);
    expect(blocks.map((b) => b.id)).toEqual(["b1"]);
    expect(blocks[0].content).toBe("");
  });

  it("returns an empty list for a null column instead of throwing", () => {
    expect(sanitizeBlocks(null)).toEqual([]);
    expect(sanitizeBlocks(undefined)).toEqual([]);
    expect(sanitizeBlocks({})).toEqual([]);
  });
});
