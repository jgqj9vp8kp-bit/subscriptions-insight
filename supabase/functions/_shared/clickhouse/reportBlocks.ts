// Report blocks — the editable half of a report (R6).
//
// A report is two things stacked: a frozen deterministic snapshot (tables,
// deltas, statuses — computed, never edited) and a list of prose blocks the
// operator writes or the model drafts. This module owns the second half, and
// only the second half: nothing here can change a number.
//
// Ordering is deliberately two-level. A block belongs to a SECTION, sections
// render in a fixed editorial order (the order the weekly reports have settled
// into), and within a section the array order is what the operator arranges.
// That way "move up" can never smuggle a conclusion above the KPI table it is
// concluding from, and adding a section later does not reshuffle saved reports.
//
// Every operation returns a new array. The editor keeps blocks in React state
// and autosaves them, so an in-place mutation would be invisible to a re-render
// and would silently persist half an edit.
import type { ReportBlock, ReportBlockType, ReportSectionKey } from "./reportContract.ts";

/** Editorial order of the report. Also the order the renderer emits sections. */
export const SECTION_ORDER: readonly ReportSectionKey[] = [
  "highlights",
  "executive_summary",
  "kpi",
  "funnels",
  "geo_payments",
  "channels",
  "monetization",
  "support",
  "email",
  "product",
  "plan_fact",
  "next_tasks",
  "risks_decisions",
];

export const SECTION_LABELS: Record<ReportSectionKey, string> = {
  highlights: "Главное за неделю",
  executive_summary: "Главный вывод недели",
  kpi: "Ключевые показатели",
  funnels: "Результаты по воронкам",
  geo_payments: "ГЕО и платежи",
  channels: "Каналы трафика",
  monetization: "Дополнительная монетизация",
  support: "Support и качество продукта",
  email: "Email-маркетинг",
  product: "Продукт и инфраструктура",
  plan_fact: "План / Факт",
  next_tasks: "Задачи на следующую неделю",
  risks_decisions: "Риски и решения",
};

/**
 * Block types the editor can create and the renderer can print as prose.
 *
 * The other types in `ReportBlockType` (metrics_table, funnel_table, chart, …)
 * are placeholders for content the snapshot already renders deterministically —
 * they exist in the contract so a future template can position them, not so a
 * human can type a table into one.
 */
export const PROSE_BLOCK_TYPES: readonly ReportBlockType[] = ["text", "ai_summary"];

export function isProseBlock(block: ReportBlock): boolean {
  return PROSE_BLOCK_TYPES.includes(block.type);
}

/**
 * Upper bound on one block's body.
 *
 * The snapshot budget assumed ~28 KB of prose across a whole report. This cap
 * is per block and generous against that, but it is a real limit: without one, a
 * paste of a full support-inbox export would land in a jsonb column that the
 * list view, every version row and every model prompt then carries forever.
 */
export const MAX_BLOCK_CONTENT_CHARS = 8000;
export const MAX_BLOCK_TITLE_CHARS = 200;

export interface NewBlockInit {
  /** Caller-supplied so this module stays pure and tests stay deterministic. */
  id: string;
  section: ReportSectionKey;
  now: string;
  type?: ReportBlockType;
  title?: string;
  content?: string;
  generatedBy?: ReportBlock["generatedBy"];
  evidence?: readonly string[];
}

export function newReportBlock(init: NewBlockInit): ReportBlock {
  return {
    id: init.id,
    type: init.type ?? "text",
    section: init.section,
    title: init.title ?? SECTION_LABELS[init.section],
    content: init.content ?? "",
    hidden: false,
    pinned: false,
    generatedBy: init.generatedBy ?? "human",
    editedByHuman: false,
    evidence: [...(init.evidence ?? [])],
    updatedAt: init.now,
  };
}

export function blocksInSection(
  blocks: readonly ReportBlock[],
  section: ReportSectionKey,
): ReportBlock[] {
  return blocks.filter((block) => block.section === section);
}

/** Sections that currently hold at least one block, in editorial order. */
export function usedSections(blocks: readonly ReportBlock[]): ReportSectionKey[] {
  return SECTION_ORDER.filter((section) => blocks.some((block) => block.section === section));
}

/**
 * Blocks in the order they should be read: by section, then by arrangement.
 *
 * A block whose section is not in `SECTION_ORDER` (an older schema, a template
 * we no longer ship) is kept and sorted last rather than dropped — losing an
 * operator's paragraph to silently fix an enum would be the worse failure.
 */
export function orderedBlocks(blocks: readonly ReportBlock[]): ReportBlock[] {
  const rank = new Map(SECTION_ORDER.map((section, index) => [section, index]));
  return [...blocks].sort((a, b) => {
    const ra = rank.get(a.section) ?? SECTION_ORDER.length;
    const rb = rank.get(b.section) ?? SECTION_ORDER.length;
    if (ra !== rb) return ra - rb;
    return blocks.indexOf(a) - blocks.indexOf(b);
  });
}

export function addBlock(blocks: readonly ReportBlock[], block: ReportBlock): ReportBlock[] {
  return [...blocks, block];
}

export function removeBlock(blocks: readonly ReportBlock[], id: string): ReportBlock[] {
  return blocks.filter((block) => block.id !== id);
}

/**
 * Apply an edit to one block.
 *
 * Editing the prose of an AI block flips `editedByHuman` and never flips back:
 * once a person has rewritten a sentence, the report must not keep claiming the
 * model wrote it, and a regeneration has to treat it as the human's text.
 * Toggling `hidden` or `pinned` is not an edit of the prose and leaves the
 * provenance alone.
 */
export function patchBlock(
  blocks: readonly ReportBlock[],
  id: string,
  changes: Partial<Pick<ReportBlock, "title" | "content" | "hidden" | "pinned" | "type" | "section">>,
  now: string,
): ReportBlock[] {
  return blocks.map((block) => {
    if (block.id !== id) return block;
    const touchesProse =
      (changes.title !== undefined && changes.title !== block.title) ||
      (changes.content !== undefined && changes.content !== block.content);
    const next: ReportBlock = {
      ...block,
      ...changes,
      updatedAt: touchesProse ? now : block.updatedAt,
      editedByHuman: block.editedByHuman || (touchesProse && block.generatedBy === "ai"),
    };
    if (next.title.length > MAX_BLOCK_TITLE_CHARS) next.title = next.title.slice(0, MAX_BLOCK_TITLE_CHARS);
    if (next.content.length > MAX_BLOCK_CONTENT_CHARS) next.content = next.content.slice(0, MAX_BLOCK_CONTENT_CHARS);
    return next;
  });
}

/**
 * Move a block one position within its own section.
 *
 * Positions are counted among the block's section-mates, so a block never jumps
 * over a section boundary by pressing "up" enough times — changing section is an
 * explicit act (`patchBlock` with a new section, or a drop onto another section).
 */
export function moveBlockWithinSection(
  blocks: readonly ReportBlock[],
  id: string,
  delta: -1 | 1,
): ReportBlock[] {
  const target = blocks.find((block) => block.id === id);
  if (!target) return [...blocks];
  const siblings = blocksInSection(blocks, target.section);
  const at = siblings.indexOf(target);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= siblings.length) return [...blocks];

  const swapWith = siblings[to];
  const indexA = blocks.indexOf(target);
  const indexB = blocks.indexOf(swapWith);
  const next = [...blocks];
  next[indexA] = swapWith;
  next[indexB] = target;
  return next;
}

/**
 * Drag-and-drop: put `sourceId` where `targetId` currently is.
 *
 * Dropping onto a block in another section moves the block into that section —
 * this is the only reordering path that crosses a section boundary, and it is
 * one the operator performed deliberately with a pointer.
 */
export function reorderBlock(
  blocks: readonly ReportBlock[],
  sourceId: string,
  targetId: string,
): ReportBlock[] {
  if (sourceId === targetId) return [...blocks];
  const from = blocks.findIndex((block) => block.id === sourceId);
  const to = blocks.findIndex((block) => block.id === targetId);
  if (from < 0 || to < 0) return [...blocks];

  const moved: ReportBlock = { ...blocks[from], section: blocks[to].section };
  const rest = blocks.filter((_, index) => index !== from);
  const insertAt = rest.findIndex((block) => block.id === targetId);
  return [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)];
}

// ---------------------------------------------------------------------------
// Defensive load
// ---------------------------------------------------------------------------

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Turn whatever came back from the `blocks` jsonb column into blocks.
 *
 * The column is written by this app but read by every future version of it, so
 * this has to survive a row saved before a field existed. The rule everywhere:
 * repair, do not discard — a block with an unknown type becomes text, a block
 * with an unknown section keeps it (see `orderedBlocks`), and only an entry that
 * is not an object at all is dropped.
 */
export function sanitizeBlocks(raw: unknown): ReportBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: ReportBlock[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = str(record.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const type = str(record.type, "text") as ReportBlockType;
    out.push({
      id,
      type,
      section: str(record.section, "executive_summary") as ReportSectionKey,
      title: str(record.title).slice(0, MAX_BLOCK_TITLE_CHARS),
      content: str(record.content).slice(0, MAX_BLOCK_CONTENT_CHARS),
      hidden: record.hidden === true,
      pinned: record.pinned === true,
      generatedBy: record.generatedBy === "ai" || record.generatedBy === "deterministic"
        ? record.generatedBy
        : "human",
      editedByHuman: record.editedByHuman === true,
      evidence: Array.isArray(record.evidence)
        ? record.evidence.filter((item): item is string => typeof item === "string")
        : [],
      updatedAt: str(record.updatedAt),
    });
  }
  return out;
}
