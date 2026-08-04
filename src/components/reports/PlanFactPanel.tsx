// Plan/Fact and next-week tasks (R7).
//
// Tasks live between reports, not inside one: what is still open on Sunday is
// what next week's report opens with. The weekly reports show this every time —
// "перенесли задачу на эту неделю" with a reason attached — so the reason a
// task moved is a first-class field, not a comment.
import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import type { ReportTask, ReportTaskPriority, ReportTaskStatus } from "@/services/reportContract";
import {
  deleteReportTask, listReportTasks, partitionTasksForPeriod, saveReportTask,
} from "@/services/reportWorkItems";

const STATUS_LABELS: Record<ReportTaskStatus, string> = {
  planned: "Запланирована",
  in_progress: "В процессе",
  done: "Готово",
  paused: "На паузе",
  blocked: "Заблокирована",
  moved: "Перенесена",
  cancelled: "Отменена",
};

const PRIORITY_LABELS: Record<ReportTaskPriority, string> = {
  high: "высокий",
  medium: "средний",
  low: "низкий",
};

const STATUS_TONE: Partial<Record<ReportTaskStatus, string>> = {
  done: "text-success",
  blocked: "text-destructive",
  moved: "text-warning",
  paused: "text-warning",
};

export function PlanFactPanel({ period, reportId, onTasksChange }: {
  period: { from: string; to: string };
  reportId: string | null;
  onTasksChange?: (tasks: { closed: ReportTask[]; open: ReportTask[] }) => void;
}) {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<ReportTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newPriority, setNewPriority] = useState<ReportTaskPriority>("medium");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listReportTasks();
      setTasks(rows);
      onTasksChange?.(partitionTasksForPeriod(rows, period));
    } catch (error) {
      toast({
        title: "Не удалось загрузить задачи",
        description: error instanceof Error ? error.message : "Неизвестная ошибка",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
    // onTasksChange is intentionally out of the dependency list: the parent
    // rebuilds it every render, and including it would refetch on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast, period.from, period.to]);

  useEffect(() => { void refresh(); }, [refresh]);

  const split = partitionTasksForPeriod(tasks, period);

  async function patch(task: ReportTask, changes: Partial<ReportTask>) {
    setBusyId(task.id);
    try {
      await saveReportTask({ id: task.id, ...changes });
      await refresh();
    } catch (error) {
      toast({
        title: "Не удалось сохранить задачу",
        description: error instanceof Error ? error.message : "Неизвестная ошибка",
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function onAdd() {
    const title = newTitle.trim();
    if (!title) return;
    setBusyId("new");
    try {
      await saveReportTask({
        title,
        priority: newPriority,
        status: "planned",
        plannedDate: period.to,
        firstReportId: reportId,
      });
      setNewTitle("");
      await refresh();
    } catch (error) {
      toast({
        title: "Не удалось добавить задачу",
        description: error instanceof Error ? error.message : "Неизвестная ошибка",
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  }

  function TaskRows({ rows, carried }: { rows: ReportTask[]; carried: boolean }) {
    return (
      <>
        {rows.map((task) => (
          <TableRow key={task.id}>
            <TableCell className="font-medium">
              {task.title}
              {carried && task.status === "moved" && task.movedReason && (
                <div className="text-xs text-warning">перенос: {task.movedReason}</div>
              )}
            </TableCell>
            <TableCell>
              <Select
                value={task.status}
                onValueChange={(value) => void patch(task, { status: value as ReportTaskStatus,
                  // Closing a task stamps the date the report uses to decide
                  // which week it belongs to.
                  ...(value === "done" ? { actualDate: period.to, closedReportId: reportId } : {}) })}
              >
                <SelectTrigger className={`h-8 w-[150px] text-xs ${STATUS_TONE[task.status] ?? ""}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(STATUS_LABELS) as ReportTaskStatus[]).map((status) => (
                    <SelectItem key={status} value={status}>{STATUS_LABELS[status]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </TableCell>
            <TableCell>
              <Badge variant="outline" className="text-xs font-normal">
                {PRIORITY_LABELS[task.priority]}
              </Badge>
            </TableCell>
            <TableCell>
              <Input
                className="h-8 text-xs"
                defaultValue={task.status === "moved" ? (task.movedReason ?? "") : (task.comment ?? "")}
                placeholder={task.status === "moved" ? "причина переноса" : "комментарий"}
                onBlur={(e) => {
                  const value = e.target.value.trim() || null;
                  const current = task.status === "moved" ? task.movedReason : task.comment;
                  if (value === current) return;
                  void patch(task, task.status === "moved" ? { movedReason: value } : { comment: value });
                }}
              />
            </TableCell>
            <TableCell className="text-right">
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7"
                aria-label={`Удалить задачу ${task.title}`}
                disabled={busyId === task.id}
                onClick={() => void (async () => {
                  setBusyId(task.id);
                  try { await deleteReportTask(task.id); await refresh(); }
                  finally { setBusyId(null); }
                })()}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </>
    );
  }

  return (
    <Card className="p-0 shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Input
          className="h-9 flex-1 min-w-[220px]"
          placeholder="Новая задача на следующую неделю…"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void onAdd(); }}
        />
        <Select value={newPriority} onValueChange={(v) => setNewPriority(v as ReportTaskPriority)}>
          <SelectTrigger className="h-9 w-[130px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(Object.keys(PRIORITY_LABELS) as ReportTaskPriority[]).map((p) => (
              <SelectItem key={p} value={p}>{PRIORITY_LABELS[p]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" onClick={() => void onAdd()} disabled={busyId === "new" || !newTitle.trim()}>
          {busyId === "new" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Добавить
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Загрузка задач…
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Задача</TableHead>
              <TableHead className="w-[170px]">Статус</TableHead>
              <TableHead className="w-[110px]">Приоритет</TableHead>
              <TableHead>Комментарий</TableHead>
              <TableHead className="w-[50px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {split.closed.length > 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="bg-muted/40 py-1.5 text-xs font-medium text-muted-foreground">
                  <Check className="mr-1 inline h-3.5 w-3.5" />
                  Закрыто за период ({split.closed.length})
                </TableCell>
              </TableRow>
            )}
            <TaskRows rows={split.closed} carried={false} />
            {split.open.length > 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="bg-muted/40 py-1.5 text-xs font-medium text-muted-foreground">
                  Переходит на следующую неделю ({split.open.length})
                </TableCell>
              </TableRow>
            )}
            <TaskRows rows={split.open} carried />
            {!split.closed.length && !split.open.length && (
              <TableRow>
                <TableCell colSpan={5} className="h-20 text-center text-sm text-muted-foreground">
                  Задач пока нет.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
