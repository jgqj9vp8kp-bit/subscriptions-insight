// Report export (R8) — the browser half.
//
// The pure rendering lives in _shared/clickhouse/reportRender.ts; this file
// only moves bytes: a download, the clipboard, and a print window.
//
// No PDF library is involved on purpose. The browser's own print pipeline
// produces a PDF whose tables are real text you can select and search; jspdf
// with html2canvas would rasterise the same tables into a blurry image, and a
// server-side renderer is not available on Deno Edge.
export * from "../../supabase/functions/_shared/clickhouse/reportRender.ts";

import {
  renderReportDocument,
  renderReportHtml,
  renderReportMarkdown,
  type RenderInput,
} from "../../supabase/functions/_shared/clickhouse/reportRender.ts";

function download(filename: string, content: string, mime: string): void {
  // Same recipe as cohortsExport: BOM first so Excel and Word read UTF-8.
  const blob = new Blob(["﻿", content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function stamp(input: RenderInput): string {
  return `${input.snapshot.period.from}_${input.snapshot.period.to}`;
}

export function downloadReportMarkdown(input: RenderInput): void {
  download(`report-${stamp(input)}.md`, renderReportMarkdown(input), "text/markdown");
}

export function downloadReportHtml(input: RenderInput): void {
  download(`report-${stamp(input)}.html`, renderReportDocument(input), "text/html");
}

/**
 * Put the report on the clipboard as rich text.
 *
 * Writing `text/html` is what makes a paste into Google Docs or Word arrive
 * with its headings and tables intact — which is the operator's actual
 * publishing step today. The plain-text flavour rides along so a paste into a
 * chat or a terminal still says something useful.
 */
export async function copyReportForDocs(input: RenderInput): Promise<void> {
  const html = renderReportHtml(input);
  const text = renderReportMarkdown(input);
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (clipboard && typeof ClipboardItem !== "undefined" && clipboard.write) {
    await clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      }),
    ]);
    return;
  }
  if (clipboard?.writeText) {
    await clipboard.writeText(text);
    return;
  }
  throw new Error("Буфер обмена недоступен в этом браузере.");
}

/**
 * Open the report in a print window.
 *
 * The window is written to directly rather than navigated to a route: the
 * document is self-contained, so nothing has to load, and print() can be called
 * the moment it is parsed.
 */
export function printReport(input: RenderInput): void {
  const printWindow = window.open("", "_blank", "width=900,height=1200");
  if (!printWindow) throw new Error("Браузер заблокировал окно печати.");
  printWindow.document.write(renderReportDocument(input));
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
}
