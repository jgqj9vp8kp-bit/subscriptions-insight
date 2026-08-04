// Weekly report — rendering (R8).
//
// Snapshot + findings + tasks in, Markdown or HTML out. Pure, so the same
// report renders identically in the browser, in a test and (later) server-side.
//
// The output formats were chosen against the operator's actual workflow, which
// is a DOCX shared as a Google Docs link:
//   * HTML  — the preview, and the payload for "copy for Google Docs": pasting
//             text/html into Docs or Word keeps headings, tables and links.
//   * print — the same HTML through the browser's own print pipeline, which
//             produces a text PDF with real, selectable tables. jspdf +
//             html2canvas would rasterise them into an unreadable image.
//   * Markdown — a plain-text fallback that survives anywhere.
//
// Nothing here reaches for a Markdown or sanitiser library: the report body is
// a constrained block model, not free HTML, so there is no untrusted markup to
// neutralise. escapeHtml below is the whole defence, and it is enough BECAUSE
// the model can only ever fill in text — never tags.
import type {
  ReportBlock, ReportFunnelRow, ReportMetric, ReportSectionKey, ReportSnapshot, ReportTask,
} from "./reportContract.ts";
import { provisionalReasonLabel } from "./reportContract.ts";
import { UNAVAILABLE_RENDER } from "./reportBuilder.ts";
import { isProseBlock, orderedBlocks, SECTION_LABELS, SECTION_ORDER } from "./reportBlocks.ts";

export interface RenderInput {
  title: string;
  snapshot: ReportSnapshot;
  blocks: readonly ReportBlock[];
  highlights: readonly string[];
  tasks?: { closed: readonly ReportTask[]; open: readonly ReportTask[] };
}

const FUNNEL_STATUS_RU: Record<string, string> = {
  scale: "Масштабировать",
  continue_testing: "Продолжать тест",
  needs_optimization: "Требует оптимизации",
  reduce_budget: "Снизить бюджет",
  pause: "Пауза",
  insufficient_data: "Мало данных",
};

const TASK_STATUS_RU: Record<string, string> = {
  planned: "Запланирована",
  in_progress: "В процессе",
  done: "Готово",
  paused: "На паузе",
  blocked: "Заблокирована",
  moved: "Перенесена",
  cancelled: "Отменена",
};

/**
 * Prose that belongs beside a given section, in the operator's arrangement.
 *
 * Blocks are placed next to the numbers they talk about rather than in one pile
 * at the top: the conclusion about the funnels reads directly under the funnel
 * table, which is how the weekly reports are actually written. Hidden blocks and
 * non-prose types never reach a rendered document.
 */
function proseFor(blocks: readonly ReportBlock[], section: ReportSectionKey): ReportBlock[] {
  return orderedBlocks(blocks).filter(
    (block) => block.section === section && !block.hidden && isProseBlock(block),
  );
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function deltaText(metric: ReportMetric): string {
  if (!metric.delta) return UNAVAILABLE_RENDER;
  const marker = metric.delta.significant ? "" : " (в пределах шума)";
  return `${metric.delta.absoluteRendered} / ${metric.delta.percentRendered}${marker}`;
}

function passportText(funnel: ReportFunnelRow): string {
  const p = funnel.passport;
  if (p.incomplete) return "Паспорт воронки не заполнен.";
  const parts: string[] = [];
  if (p.trialPrice !== null) {
    parts.push(`Триал: ${p.trialPrice}${p.trialCurrency ?? "$"}` +
      (p.trialDurationDays !== null ? ` длительностью ${p.trialDurationDays} дн.` : ""));
  }
  if (p.subscriptionPrice !== null) {
    parts.push(`Тариф: ${p.subscriptionPrice}${p.subscriptionCurrency ?? "$"}` +
      (p.billingPeriod ? ` (${p.billingPeriod})` : ""));
  }
  if (p.upsells.length) {
    parts.push(p.upsells
      .map((u, i) => `Апсейл ${i + 1} ${u.name}${u.price !== null ? ` ${u.price}$` : ""}`)
      .join(" | "));
  }
  if (p.geoLocalization.length) parts.push(`Локализация: ${p.geoLocalization.join(", ")}`);
  if (p.destination) parts.push(`Ведём на ${p.destination}`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function mdTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${headers.join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}

export function renderReportMarkdown(input: RenderInput): string {
  const { snapshot } = input;
  const out: string[] = [];

  out.push(`# ${input.title}`);
  out.push(`Период: ${snapshot.period.from} — ${snapshot.period.to}` +
    (snapshot.compare ? ` (сравнение: ${snapshot.compare.from} — ${snapshot.compare.to})` : ""));

  if (snapshot.dataIncomplete) {
    out.push("", "> Данные неполные: "
      + snapshot.provisionalReasons.map(provisionalReasonLabel).join("; "));
  }

  // One pass over the editorial order, deterministic content injected where it
  // belongs and the operator's prose following it. A section with neither is
  // simply absent — an empty "Email-маркетинг" heading would read as a claim
  // that there was nothing to say, rather than nothing to measure.
  const mdProse = (section: ReportSectionKey) => {
    for (const block of proseFor(input.blocks, section)) {
      out.push("", `## ${block.title}`, "", block.content);
    }
  };

  for (const section of SECTION_ORDER) {
    if (section === "highlights") {
      // A visible block in this section is the model's rephrasing of the same
      // ranked findings — printing both would say everything twice. Hiding the
      // block brings the deterministic list back, which is also what happens
      // when there is no model at all.
      if (input.highlights.length && !proseFor(input.blocks, "highlights").length) {
        out.push("", `## ${SECTION_LABELS.highlights}`, "");
        for (const line of input.highlights) out.push(`- ${line}`);
      }
    } else if (section === "kpi") {
      out.push("", "## Ключевые показатели недели", "");
      out.push(mdTable(
        ["Показатель", "Период", "Прошлый", "Изменение", "Цель", "Выборка"],
        Object.values(snapshot.kpi).map((metric) => [
          metric.label,
          metric.current.rendered,
          metric.delta?.previousRendered ?? UNAVAILABLE_RENDER,
          deltaText(metric),
          metric.target?.rendered ?? UNAVAILABLE_RENDER,
          metric.sampleSize === null ? UNAVAILABLE_RENDER : String(metric.sampleSize),
        ]),
      ));
    } else if (section === "funnels") {
      if (snapshot.funnels.length) {
        out.push("", "## Результаты по воронкам");
        for (const funnel of snapshot.funnels) {
          out.push("", `### ${funnel.funnelPath}${funnel.isNew ? " (новая)" : ""}`);
          out.push(passportText(funnel));
          out.push("", `**${FUNNEL_STATUS_RU[funnel.status.status] ?? funnel.status.status}** — ${funnel.status.because}`);
          const metrics = Object.values(funnel.metrics);
          if (metrics.length) {
            out.push("", mdTable(
              metrics.map((m) => m.label),
              [metrics.map((m) => m.current.rendered)],
            ));
          }
        }
      }
    } else if (section === "plan_fact") {
      if (input.tasks && (input.tasks.closed.length || input.tasks.open.length)) {
        out.push("", "## План / Факт", "");
        out.push(mdTable(
          ["Задача", "Статус", "Приоритет", "Комментарий"],
          [...input.tasks.closed, ...input.tasks.open].map((task) => [
            task.title,
            TASK_STATUS_RU[task.status] ?? task.status,
            task.priority,
            task.movedReason || task.comment || "",
          ]),
        ));
      }
    }
    mdProse(section);
  }

  if (snapshot.gaps.length) {
    out.push("", "## Чего не хватает в данных", "");
    for (const gap of snapshot.gaps) out.push(`- **${gap.label}** — ${gap.reason}`);
  }

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/**
 * A block body as HTML.
 *
 * The supported markdown is exactly one construct: a line starting with "- " is
 * a list item. That is the whole "constrained subset" — the narrative writes
 * bullet lists and paragraphs and nothing else, and every character still goes
 * through escapeHtml, so this cannot become a way to emit markup.
 */
function proseParagraphs(content: string): string[] {
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (!list.length) return;
    out.push(`<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
    list = [];
  };

  for (const rawBlock of content.split(/\n{2,}/)) {
    for (const rawLine of rawBlock.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("- ")) {
        list.push(line.slice(2).trim());
      } else {
        flush();
        out.push(`<p>${escapeHtml(line)}</p>`);
      }
    }
    flush();
  }
  flush();
  return out;
}

function htmlTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * Print-oriented CSS.
 *
 * `@page` gives the PDF its margins; `break-inside: avoid` keeps a funnel block
 * or a table row from being split across a page break, which is what makes the
 * printed report readable rather than merely produced.
 */
export const REPORT_PRINT_CSS = `
@page { size: A4; margin: 18mm 14mm; }
body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; font-size: 11pt; color: #111; line-height: 1.45; }
h1 { font-size: 20pt; margin: 0 0 4pt; }
h2 { font-size: 14pt; margin: 18pt 0 6pt; }
h3 { font-size: 12pt; margin: 12pt 0 4pt; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0; font-size: 9.5pt; }
th, td { border: 1px solid #ccc; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #f4f4f5; font-weight: 600; }
td:not(:first-child), th:not(:first-child) { text-align: right; }
.meta { color: #666; font-size: 9.5pt; }
.warn { border-left: 3px solid #d97706; background: #fffbeb; padding: 6pt 8pt; margin: 8pt 0; }
.passport { color: #444; font-size: 9.5pt; margin: 2pt 0; }
.status { font-weight: 600; }
section, tr, h2, h3 { break-inside: avoid; }
h2, h3 { break-after: avoid; }
`;

export function renderReportHtml(input: RenderInput): string {
  const { snapshot } = input;
  const out: string[] = [];

  out.push(`<h1>${escapeHtml(input.title)}</h1>`);
  out.push(`<p class="meta">Период: ${escapeHtml(snapshot.period.from)} — ${escapeHtml(snapshot.period.to)}` +
    (snapshot.compare
      ? ` (сравнение: ${escapeHtml(snapshot.compare.from)} — ${escapeHtml(snapshot.compare.to)})`
      : "") + `</p>`);

  if (snapshot.dataIncomplete) {
    out.push(`<div class="warn">Данные неполные: `
      + `${escapeHtml(snapshot.provisionalReasons.map(provisionalReasonLabel).join("; "))}</div>`);
  }

  // Same editorial pass as the Markdown renderer, so the two formats can never
  // disagree about where a paragraph belongs.
  const htmlProse = (section: ReportSectionKey) => {
    for (const block of proseFor(input.blocks, section)) {
      out.push(`<section><h2>${escapeHtml(block.title)}</h2>`);
      out.push(...proseParagraphs(block.content));
      out.push("</section>");
    }
  };

  for (const section of SECTION_ORDER) {
    if (section === "highlights") {
      if (input.highlights.length && !proseFor(input.blocks, "highlights").length) {
        out.push(`<section><h2>${escapeHtml(SECTION_LABELS.highlights)}</h2><ul>`);
        for (const line of input.highlights) out.push(`<li>${escapeHtml(line)}</li>`);
        out.push("</ul></section>");
      }
    } else if (section === "kpi") {
      out.push("<section><h2>Ключевые показатели недели</h2>");
      out.push(htmlTable(
        ["Показатель", "Период", "Прошлый", "Изменение", "Цель", "Выборка"],
        Object.values(snapshot.kpi).map((metric) => [
          metric.label,
          metric.current.rendered,
          metric.delta?.previousRendered ?? UNAVAILABLE_RENDER,
          deltaText(metric),
          metric.target?.rendered ?? UNAVAILABLE_RENDER,
          metric.sampleSize === null ? UNAVAILABLE_RENDER : String(metric.sampleSize),
        ]),
      ));
      out.push("</section>");
    } else if (section === "funnels") {
      if (snapshot.funnels.length) {
        out.push("<section><h2>Результаты по воронкам</h2>");
        for (const funnel of snapshot.funnels) {
          out.push(`<section><h3>${escapeHtml(funnel.funnelPath)}${funnel.isNew ? " (новая)" : ""}</h3>`);
          out.push(`<p class="passport">${escapeHtml(passportText(funnel))}</p>`);
          out.push(`<p><span class="status">${escapeHtml(FUNNEL_STATUS_RU[funnel.status.status] ?? funnel.status.status)}</span> — ${escapeHtml(funnel.status.because)}</p>`);
          const metrics = Object.values(funnel.metrics);
          if (metrics.length) {
            out.push(htmlTable(metrics.map((m) => m.label), [metrics.map((m) => m.current.rendered)]));
          }
          out.push("</section>");
        }
        out.push("</section>");
      }
    } else if (section === "plan_fact") {
      if (input.tasks && (input.tasks.closed.length || input.tasks.open.length)) {
        out.push("<section><h2>План / Факт</h2>");
        out.push(htmlTable(
          ["Задача", "Статус", "Приоритет", "Комментарий"],
          [...input.tasks.closed, ...input.tasks.open].map((task) => [
            task.title,
            TASK_STATUS_RU[task.status] ?? task.status,
            task.priority,
            task.movedReason || task.comment || "",
          ]),
        ));
        out.push("</section>");
      }
    }
    htmlProse(section);
  }

  if (snapshot.gaps.length) {
    out.push("<section><h2>Чего не хватает в данных</h2><ul>");
    for (const gap of snapshot.gaps) {
      out.push(`<li><strong>${escapeHtml(gap.label)}</strong> — ${escapeHtml(gap.reason)}</li>`);
    }
    out.push("</ul></section>");
  }

  return out.join("\n");
}

/** A standalone document for printing or for the clipboard. */
export function renderReportDocument(input: RenderInput): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">` +
    `<title>${escapeHtml(input.title)}</title><style>${REPORT_PRINT_CSS}</style></head>` +
    `<body>${renderReportHtml(input)}</body></html>`;
}
