// The block editor (R6).
//
// Everything a person writes into a report lives here; everything a person can
// *not* write lives in the snapshot above. That split is the whole point of the
// page — the editor has no field that accepts a number into a table, so no edit
// made here can contradict the data the report was collected from.
//
// Ordering is native HTML5 drag (the precedent is the draggable column header in
// Cohorts) plus up/down buttons, so reordering works from a keyboard and on a
// touchpad without a drag library.
import { useState } from "react";
import {
  ChevronDown, ChevronUp, Eye, EyeOff, GripVertical, Loader2, Pin, PinOff, Plus, X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ReportBlock, ReportSectionKey } from "@/services/reportContract";
import {
  addBlock, blocksInSection, MAX_BLOCK_CONTENT_CHARS, moveBlockWithinSection, newReportBlock,
  patchBlock, removeBlock, reorderBlock, SECTION_LABELS, SECTION_ORDER, usedSections,
} from "@/services/reportBlocks";

export type BlockSaveState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved"; at: string }
  | { kind: "error"; message: string };

/** Inline status, not a toast: autosave fires every few seconds and a toast
 * storm for something that always works would train the operator to ignore it.
 * The only state worth interrupting for is the failure. */
function SaveStatus({ state }: { state: BlockSaveState }) {
  if (state.kind === "idle") return null;
  if (state.kind === "error") {
    return <span className="text-xs text-destructive">Не сохранено: {state.message}</span>;
  }
  if (state.kind === "saving") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Сохранение…
      </span>
    );
  }
  if (state.kind === "pending") {
    return <span className="text-xs text-muted-foreground">Есть несохранённые правки…</span>;
  }
  return <span className="text-xs text-muted-foreground">Сохранено в {state.at}</span>;
}

export function BlockEditor({ blocks, onChange, saveState }: {
  blocks: ReportBlock[];
  onChange: (next: ReportBlock[]) => void;
  saveState: BlockSaveState;
}) {
  const [newSection, setNewSection] = useState<ReportSectionKey>("executive_summary");
  const [dragId, setDragId] = useState<string | null>(null);

  const now = () => new Date().toISOString();

  function onAdd() {
    onChange(addBlock(blocks, newReportBlock({
      id: crypto.randomUUID(),
      section: newSection,
      now: now(),
    })));
  }

  function onDrop(targetId: string, transferred: string) {
    const sourceId = transferred || dragId;
    setDragId(null);
    if (sourceId) onChange(reorderBlock(blocks, sourceId, targetId));
  }

  const sections = usedSections(blocks);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={newSection} onValueChange={(value) => setNewSection(value as ReportSectionKey)}>
          <SelectTrigger className="h-9 w-[240px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {SECTION_ORDER.map((section) => (
              <SelectItem key={section} value={section}>{SECTION_LABELS[section]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <Plus className="h-4 w-4" /> Добавить блок
        </Button>
        <div className="ml-auto"><SaveStatus state={saveState} /></div>
      </div>

      {sections.length === 0 && (
        <Card className="p-4 text-sm text-muted-foreground">
          Блоков нет. Таблицы, статусы и экспорт работают и без них — блок нужен там,
          где к цифрам добавляется вывод или решение.
        </Card>
      )}

      {sections.map((section) => {
        const siblings = blocksInSection(blocks, section);
        return (
          <section key={section} className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {SECTION_LABELS[section]}
            </h3>
            {siblings.map((block, index) => (
              <Card
                key={block.id}
                className={`space-y-2 p-3 ${block.hidden ? "opacity-55" : ""} ${
                  dragId === block.id ? "ring-1 ring-primary" : ""
                }`}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
                onDrop={(event) => {
                  event.preventDefault();
                  onDrop(block.id, event.dataTransfer.getData("text/plain"));
                }}
              >
                <div className="flex items-center gap-2">
                  <span
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", block.id);
                      event.dataTransfer.effectAllowed = "move";
                      setDragId(block.id);
                    }}
                    onDragEnd={() => setDragId(null)}
                    title="Перетащите, чтобы изменить порядок"
                    className="cursor-grab text-muted-foreground active:cursor-grabbing"
                  >
                    <GripVertical className="h-4 w-4" />
                  </span>

                  <Input
                    className="h-8 flex-1 font-medium"
                    value={block.title}
                    placeholder="Заголовок блока"
                    onChange={(event) =>
                      onChange(patchBlock(blocks, block.id, { title: event.target.value }, now()))}
                  />

                  {block.generatedBy === "ai" && (
                    <Badge variant="outline" className="text-xs font-normal">
                      {block.editedByHuman ? "AI, правлено" : "AI"}
                    </Badge>
                  )}
                  {block.pinned && (
                    <Badge variant="secondary" className="text-xs font-normal">закреплён</Badge>
                  )}

                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7"
                    title={block.pinned ? "Открепить" : "Закрепить: перегенерация не тронет блок"}
                    aria-label={block.pinned ? "Открепить блок" : "Закрепить блок"}
                    onClick={() => onChange(patchBlock(blocks, block.id, { pinned: !block.pinned }, now()))}>
                    {block.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7"
                    title={block.hidden ? "Показать в отчёте" : "Скрыть из отчёта и экспорта"}
                    aria-label={block.hidden ? "Показать блок" : "Скрыть блок"}
                    onClick={() => onChange(patchBlock(blocks, block.id, { hidden: !block.hidden }, now()))}>
                    {block.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7"
                    aria-label="Выше" disabled={index === 0}
                    onClick={() => onChange(moveBlockWithinSection(blocks, block.id, -1))}>
                    <ChevronUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7"
                    aria-label="Ниже" disabled={index === siblings.length - 1}
                    onClick={() => onChange(moveBlockWithinSection(blocks, block.id, 1))}>
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7"
                    aria-label={`Удалить блок ${block.title}`}
                    onClick={() => onChange(removeBlock(blocks, block.id))}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>

                <Textarea
                  className="min-h-[90px] text-sm"
                  value={block.content}
                  maxLength={MAX_BLOCK_CONTENT_CHARS}
                  placeholder="Факт → вывод → решение. Цифры берите из таблиц выше — они уже посчитаны."
                  onChange={(event) =>
                    onChange(patchBlock(blocks, block.id, { content: event.target.value }, now()))}
                />

                <div className="flex items-center gap-2">
                  <Select
                    value={block.section}
                    onValueChange={(value) =>
                      onChange(patchBlock(blocks, block.id, { section: value as ReportSectionKey }, now()))}
                  >
                    <SelectTrigger className="h-7 w-[220px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SECTION_ORDER.map((option) => (
                        <SelectItem key={option} value={option}>{SECTION_LABELS[option]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {block.hidden && (
                    <span className="text-xs text-muted-foreground">не попадёт в отчёт и экспорт</span>
                  )}
                </div>
              </Card>
            ))}
          </section>
        );
      })}
    </div>
  );
}
