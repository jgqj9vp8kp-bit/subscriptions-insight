import { useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  FileSpreadsheet,
  Link as LinkIcon,
  Loader2,
  RotateCcw,
  Upload,
} from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useDataStore } from "@/store/dataStore";
import {
  applyMapping,
  autoMap,
  fetchGoogleSheetCsv,
  parseCSVFile,
  TARGET_FIELDS,
  type ColumnMapping,
  type ParsedSheet,
} from "@/services/import";
import type { Transaction } from "@/services/types";

const NONE = "__none__";

export default function ImportPage() {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const meta = useDataStore((s) => s.meta);
  const setImported = useDataStore((s) => s.setImported);
  const resetToMock = useDataStore((s) => s.resetToMock);

  const [tab, setTab] = useState<"csv" | "google">("csv");
  const [parsed, setParsed] = useState<ParsedSheet | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [sourceLabel, setSourceLabel] = useState<string>("");
  const [sourceKind, setSourceKind] = useState<"csv" | "google_sheet">("csv");
  const [sheetUrl, setSheetUrl] = useState("");
  const [loading, setLoading] = useState(false);

  const requiredMissing = useMemo(
    () => TARGET_FIELDS.filter((f) => f.required && !mapping[f.key]),
    [mapping]
  );

  const previewRows: Transaction[] = useMemo(() => {
    if (!parsed) return [];
    return applyMapping({ headers: parsed.headers, rows: parsed.rows.slice(0, 5) }, mapping).rows;
  }, [parsed, mapping]);

  function handleParsed(p: ParsedSheet, label: string, kind: "csv" | "google_sheet") {
    if (!p.headers.length || !p.rows.length) {
      toast({
        title: "Empty file",
        description: "No rows were detected in the source.",
        variant: "destructive",
      });
      return;
    }
    setParsed(p);
    setMapping(autoMap(p.headers));
    setSourceLabel(label);
    setSourceKind(kind);
  }

  async function onFile(file: File) {
    try {
      setLoading(true);
      const p = await parseCSVFile(file);
      handleParsed(p, file.name, "csv");
    } catch (e) {
      toast({
        title: "Could not parse CSV",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  async function onLoadSheet() {
    if (!sheetUrl.trim()) return;
    try {
      setLoading(true);
      const p = await fetchGoogleSheetCsv(sheetUrl);
      handleParsed(p, sheetUrl, "google_sheet");
    } catch (e) {
      toast({
        title: "Could not load Google Sheet",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  function confirmImport() {
    if (!parsed) return;
    if (requiredMissing.length) {
      toast({
        title: "Missing required mappings",
        description: requiredMissing.map((f) => f.label).join(", "),
        variant: "destructive",
      });
      return;
    }
    const result = applyMapping(parsed, mapping);
    setImported(result.rows, {
      source: sourceKind,
      fileName: sourceKind === "csv" ? sourceLabel : undefined,
      sheetUrl: sourceKind === "google_sheet" ? sourceLabel : undefined,
    });
    toast({
      title: "Import complete",
      description: `Loaded ${result.rows.length} transactions from ${sourceKind === "csv" ? "CSV" : "Google Sheet"}.`,
    });
    setParsed(null);
    setMapping({});
  }

  return (
    <AppLayout title="Import data" description="Replace dataset with a CSV file or a public Google Sheet">
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="p-4 shadow-card lg:col-span-2">
          <Tabs value={tab} onValueChange={(v) => setTab(v as "csv" | "google")}>
            <TabsList className="mb-3">
              <TabsTrigger value="csv">
                <Upload className="mr-1.5 h-3.5 w-3.5" /> CSV file
              </TabsTrigger>
              <TabsTrigger value="google">
                <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" /> Google Sheet
              </TabsTrigger>
            </TabsList>

            <TabsContent value="csv" className="space-y-3">
              <div
                className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center transition-colors hover:bg-muted/60"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const file = e.dataTransfer.files?.[0];
                  if (file) onFile(file);
                }}
              >
                <Upload className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
                <p className="text-sm text-foreground">Drag a CSV file here, or</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => fileRef.current?.click()}
                  disabled={loading}
                >
                  Choose file
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onFile(f);
                    e.target.value = "";
                  }}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  First row must contain column headers.
                </p>
              </div>
            </TabsContent>

            <TabsContent value="google" className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="sheet-url" className="text-xs">Google Sheet URL</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <LinkIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="sheet-url"
                      placeholder="https://docs.google.com/spreadsheets/d/…"
                      value={sheetUrl}
                      onChange={(e) => setSheetUrl(e.target.value)}
                      className="pl-8 h-9"
                    />
                  </div>
                  <Button onClick={onLoadSheet} disabled={loading || !sheetUrl.trim()} className="h-9">
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Load"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  The sheet must be shared as <span className="font-medium text-foreground">Anyone with the link can view</span>.
                  We read the first tab via the public CSV export.
                </p>
              </div>
            </TabsContent>
          </Tabs>

          {parsed && (
            <div className="mt-4 space-y-4">
              <div className="flex items-baseline justify-between border-t border-border pt-4">
                <h3 className="text-sm font-semibold text-foreground">Map columns</h3>
                <span className="text-xs text-muted-foreground">
                  {parsed.rows.length} rows · {parsed.headers.length} columns detected
                </span>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                {TARGET_FIELDS.map((f) => (
                  <div key={f.key} className="flex items-center justify-between gap-2 rounded-md border border-border p-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm text-foreground">
                        {f.label}
                        {f.required && <span className="ml-1 text-destructive">*</span>}
                      </div>
                      <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                        {String(f.key)}
                      </div>
                    </div>
                    <Select
                      value={mapping[f.key] ?? NONE}
                      onValueChange={(v) =>
                        setMapping((m) => ({ ...m, [f.key]: v === NONE ? undefined : v }))
                      }
                    >
                      <SelectTrigger className="h-8 w-[160px]">
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>— skip —</SelectItem>
                        {parsed.headers.map((h) => (
                          <SelectItem key={h} value={h}>{h}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>

              {requiredMissing.length > 0 && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Required: {requiredMissing.map((f) => f.label).join(", ")}
                  </span>
                </div>
              )}

              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Preview (first 5 rows)
                </h4>
                <div className="overflow-x-auto rounded-md border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Email</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Funnel</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead>Event time</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewRows.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-xs">{r.email}</TableCell>
                          <TableCell className="text-xs">{r.transaction_type}</TableCell>
                          <TableCell className="text-xs">{r.status}</TableCell>
                          <TableCell className="text-xs">{r.funnel}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">
                            ${r.amount_usd.toFixed(2)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {new Date(r.event_time).toLocaleString()}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setParsed(null);
                    setMapping({});
                  }}
                >
                  Cancel
                </Button>
                <Button onClick={confirmImport} disabled={requiredMissing.length > 0}>
                  <CheckCircle2 className="mr-1.5 h-4 w-4" />
                  Import {parsed.rows.length} rows
                </Button>
              </div>
            </div>
          )}
        </Card>

        <Card className="p-4 shadow-card">
          <div className="mb-2 flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">Current dataset</h3>
          </div>
          <dl className="space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Source</dt>
              <dd className="font-medium capitalize text-foreground">
                {meta.source.replace("_", " ")}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Rows</dt>
              <dd className="font-medium tabular-nums text-foreground">{meta.rowCount}</dd>
            </div>
            {meta.fileName && (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">File</dt>
                <dd className="truncate font-medium text-foreground" title={meta.fileName}>
                  {meta.fileName}
                </dd>
              </div>
            )}
            {meta.sheetUrl && (
              <div className="space-y-0.5">
                <dt className="text-muted-foreground">Sheet URL</dt>
                <dd className="break-all font-medium text-foreground">{meta.sheetUrl}</dd>
              </div>
            )}
            {meta.importedAt && (
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Imported at</dt>
                <dd className="tabular-nums text-foreground">
                  {new Date(meta.importedAt).toLocaleString()}
                </dd>
              </div>
            )}
          </dl>

          <Button
            variant="outline"
            size="sm"
            className="mt-4 w-full"
            onClick={() => {
              resetToMock();
              toast({ title: "Reset", description: "Restored bundled mock dataset." });
            }}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Reset to mock data
          </Button>
        </Card>
      </div>
    </AppLayout>
  );
}