// Funnel passport editor (Reports R4).
//
// The header every weekly report opens a funnel block with:
//   Триал: 1$ длительностью 3 дня | Тариф: 11,99$ в неделю
//   Апсейл 1 Zodiac Report 14.98$ | Апсейл 2 Love Map 9.99$
//   Дефолт: Английский, $ | Локализация: США, Австралия, ЮАР
//   Ведём на web-приложение
// None of it is derivable from the warehouse, so it is entered once here.
//
// trial_duration_days is the one field with teeth beyond display: without it no
// cohort can be proved mature, so the funnel's trial-to-subscription rate stays
// unmeasurable in every report. The form says so rather than letting it look
// like a cosmetic blank.
import { useEffect, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  BILLING_PERIODS, FUNNEL_DESTINATIONS, updateFunnelPassport,
  type FunnelPassportFields, type FunnelRecord, type FunnelUpsell,
} from "@/services/funnels";

const BILLING_LABELS: Record<string, string> = {
  weekly: "в неделю",
  biweekly: "раз в 2 недели",
  monthly: "в месяц",
  quarterly: "в квартал",
  annual: "в год",
  custom: "другое",
};

const DESTINATION_LABELS: Record<string, string> = {
  web_app: "web-приложение",
  ios: "iOS",
  android: "Android",
  content: "контент",
};

/** A `null` number must survive the round trip through an input: "" means the
 * operator has not set it, which is not the same fact as 0. */
function numberOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function listOrEmpty(raw: string): string[] {
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

interface FormState {
  trialPrice: string;
  trialCurrency: string;
  trialDurationDays: string;
  subscriptionPrice: string;
  subscriptionCurrency: string;
  billingPeriod: string;
  upsells: FunnelUpsell[];
  defaultLanguage: string;
  defaultCurrency: string;
  geoLocalization: string;
  destination: string;
  product: string;
  trafficSources: string;
  passportNotes: string;
}

function toForm(funnel: FunnelRecord): FormState {
  return {
    trialPrice: funnel.trial_price?.toString() ?? "",
    trialCurrency: funnel.trial_currency ?? "",
    trialDurationDays: funnel.trial_duration_days?.toString() ?? "",
    subscriptionPrice: funnel.subscription_price?.toString() ?? "",
    subscriptionCurrency: funnel.subscription_currency ?? "",
    billingPeriod: funnel.billing_period ?? "",
    upsells: funnel.upsells ?? [],
    defaultLanguage: funnel.default_language ?? "",
    defaultCurrency: funnel.default_currency ?? "",
    geoLocalization: (funnel.geo_localization ?? []).join(", "),
    destination: funnel.destination ?? "",
    product: funnel.product ?? "",
    trafficSources: (funnel.traffic_sources ?? []).join(", "),
    passportNotes: funnel.passport_notes ?? "",
  };
}

function toPatch(form: FormState): Partial<FunnelPassportFields> {
  return {
    trial_price: numberOrNull(form.trialPrice),
    trial_currency: form.trialCurrency.trim() || null,
    trial_duration_days: numberOrNull(form.trialDurationDays),
    subscription_price: numberOrNull(form.subscriptionPrice),
    subscription_currency: form.subscriptionCurrency.trim() || null,
    billing_period: form.billingPeriod || null,
    upsells: form.upsells
      .filter((upsell) => upsell.name.trim())
      .map((upsell, index) => ({ ...upsell, name: upsell.name.trim(), ordinal: index + 1 })),
    default_language: form.defaultLanguage.trim() || null,
    default_currency: form.defaultCurrency.trim() || null,
    geo_localization: listOrEmpty(form.geoLocalization),
    destination: form.destination || null,
    product: form.product.trim() || null,
    traffic_sources: listOrEmpty(form.trafficSources),
    passport_notes: form.passportNotes.trim() || null,
  };
}

/** The single line the report will print, previewed live so the operator can
 * see what they are writing rather than guessing from field names. */
function previewLine(form: FormState): string {
  const parts: string[] = [];
  const trialPrice = numberOrNull(form.trialPrice);
  const days = numberOrNull(form.trialDurationDays);
  if (trialPrice !== null) {
    const currency = form.trialCurrency.trim() || "$";
    parts.push(days !== null
      ? `Триал: ${trialPrice}${currency} длительностью ${days} дн.`
      : `Триал: ${trialPrice}${currency}`);
  }
  const subPrice = numberOrNull(form.subscriptionPrice);
  if (subPrice !== null) {
    const currency = form.subscriptionCurrency.trim() || "$";
    const period = form.billingPeriod ? ` ${BILLING_LABELS[form.billingPeriod] ?? form.billingPeriod}` : "";
    parts.push(`Тариф: ${subPrice}${currency}${period}`);
  }
  const upsells = form.upsells.filter((u) => u.name.trim());
  if (upsells.length) {
    parts.push(upsells
      .map((u, i) => `Апсейл ${i + 1} ${u.name}${u.price !== null ? ` ${u.price}$` : ""}`)
      .join(" | "));
  }
  if (form.destination) parts.push(`Ведём на ${DESTINATION_LABELS[form.destination] ?? form.destination}`);
  return parts.join(" · ") || "Заполните поля — здесь появится строка, которую напечатает отчёт.";
}

export function FunnelPassportDialog({ funnel, open, onOpenChange, onSaved }: {
  funnel: FunnelRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm(funnel ? toForm(funnel) : null);
    setError(null);
  }, [funnel]);

  if (!funnel || !form) return null;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));

  const setUpsell = (index: number, patch: Partial<FunnelUpsell>) =>
    setForm((current) => current
      ? { ...current, upsells: current.upsells.map((u, i) => (i === index ? { ...u, ...patch } : u)) }
      : current);

  async function onSave() {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      await updateFunnelPassport(funnel!.id, toPatch(form));
      onSaved();
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось сохранить паспорт.");
    } finally {
      setSaving(false);
    }
  }

  const missingDuration = numberOrNull(form.trialDurationDays) === null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Паспорт воронки</DialogTitle>
          <DialogDescription className="font-mono text-xs">{funnel.funnel_path}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
            {previewLine(form)}
          </div>

          {missingDuration && (
            <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              Без длительности триала конверсия из триала в подписку по этой воронке
              не считается: нельзя определить, успела ли когорта дожить до оплаты.
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label htmlFor="p-trial-price" className="text-xs">Цена триала</Label>
              <Input id="p-trial-price" inputMode="decimal" value={form.trialPrice}
                onChange={(e) => set("trialPrice", e.target.value)} placeholder="1" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-trial-currency" className="text-xs">Валюта триала</Label>
              <Input id="p-trial-currency" value={form.trialCurrency}
                onChange={(e) => set("trialCurrency", e.target.value)} placeholder="$" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-trial-days" className="text-xs">Длительность, дней</Label>
              <Input id="p-trial-days" inputMode="numeric" value={form.trialDurationDays}
                onChange={(e) => set("trialDurationDays", e.target.value)} placeholder="7" />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label htmlFor="p-sub-price" className="text-xs">Цена подписки</Label>
              <Input id="p-sub-price" inputMode="decimal" value={form.subscriptionPrice}
                onChange={(e) => set("subscriptionPrice", e.target.value)} placeholder="29.99" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-sub-currency" className="text-xs">Валюта подписки</Label>
              <Input id="p-sub-currency" value={form.subscriptionCurrency}
                onChange={(e) => set("subscriptionCurrency", e.target.value)} placeholder="$" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Периодичность</Label>
              <Select value={form.billingPeriod} onValueChange={(v) => set("billingPeriod", v)}>
                <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  {BILLING_PERIODS.map((period) => (
                    <SelectItem key={period} value={period}>{BILLING_LABELS[period]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Апсейлы</Label>
              <Button type="button" variant="outline" size="sm" className="h-7 text-xs"
                onClick={() => set("upsells", [...form.upsells,
                  { name: "", price: null, currency: form.defaultCurrency || null, ordinal: form.upsells.length + 1 }])}>
                <Plus className="h-3.5 w-3.5" /> Добавить
              </Button>
            </div>
            {form.upsells.length === 0 && (
              <p className="text-xs text-muted-foreground">Апсейлов нет.</p>
            )}
            {form.upsells.map((upsell, index) => (
              <div key={index} className="flex items-center gap-2">
                <span className="w-4 text-xs text-muted-foreground">{index + 1}</span>
                <Input className="flex-1" value={upsell.name} placeholder="Zodiac Report"
                  onChange={(e) => setUpsell(index, { name: e.target.value })} />
                <Input className="w-24" inputMode="decimal" placeholder="14.98"
                  value={upsell.price?.toString() ?? ""}
                  onChange={(e) => setUpsell(index, { price: numberOrNull(e.target.value) })} />
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8"
                  aria-label={`Удалить апсейл ${index + 1}`}
                  onClick={() => set("upsells", form.upsells.filter((_, i) => i !== index))}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label htmlFor="p-lang" className="text-xs">Язык по умолчанию</Label>
              <Input id="p-lang" value={form.defaultLanguage}
                onChange={(e) => set("defaultLanguage", e.target.value)} placeholder="Английский" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-currency" className="text-xs">Валюта по умолчанию</Label>
              <Input id="p-currency" value={form.defaultCurrency}
                onChange={(e) => set("defaultCurrency", e.target.value)} placeholder="$" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Куда ведём</Label>
              <Select value={form.destination} onValueChange={(v) => set("destination", v)}>
                <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  {FUNNEL_DESTINATIONS.map((destination) => (
                    <SelectItem key={destination} value={destination}>
                      {DESTINATION_LABELS[destination]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="p-geo" className="text-xs">Локализация (ГЕО через запятую)</Label>
            <Input id="p-geo" value={form.geoLocalization}
              onChange={(e) => set("geoLocalization", e.target.value)}
              placeholder="США, Австралия, ЮАР, Новая Зеландия" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="p-product" className="text-xs">Продукт</Label>
              <Input id="p-product" value={form.product}
                onChange={(e) => set("product", e.target.value)} placeholder="Palm Reading" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-sources" className="text-xs">Источники трафика</Label>
              <Input id="p-sources" value={form.trafficSources}
                onChange={(e) => set("trafficSources", e.target.value)} placeholder="facebook, tiktok" />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="p-notes" className="text-xs">Заметки</Label>
            <Input id="p-notes" value={form.passportNotes}
              onChange={(e) => set("passportNotes", e.target.value)} />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Отмена
          </Button>
          <Button type="button" onClick={() => void onSave()} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
