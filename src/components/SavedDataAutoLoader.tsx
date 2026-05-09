import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { loadLatestCloudSnapshot } from "@/services/dataSnapshots";
import { FORECASTING_DEFAULT_RETENTION_KEY, saveDefaultRetentionCurve } from "@/services/forecastingSettings";
import {
  loadLastPalmerDatasetFromCache,
  savePalmerDatasetToCache,
  type PalmerDatasetCachePayload,
} from "@/services/palmerCache";
import {
  normalizePalmerCloudPayload,
  type PalmerCloudPayload,
} from "@/services/palmerCloudSnapshot";
import {
  loadSubscriptionsFromCache,
  saveSubscriptionsToCache,
  type SubscriptionCachePayload,
} from "@/services/subscriptionCache";
import {
  loadLastTrafficDataFromCache,
  saveTrafficDataToCache,
  type TrafficCachePayload,
} from "@/services/trafficCache";
import { useDataStore } from "@/store/dataStore";
import type { TrafficMetric } from "@/services/trafficImport";
import type { SubscriptionClean } from "@/types/subscriptions";

type AutoLoadStatus = "idle" | "loading" | "loaded" | "warning";

type RestoreSource = "local cache" | "cloud";

type SubscriptionsCloudPayload = {
  subscriptions?: SubscriptionClean[];
};

type TrafficCloudPayload = {
  trafficMetrics?: TrafficMetric[];
};

type ForecastingCloudPayload = {
  retention_curve?: number[];
};

export function SavedDataAutoLoader() {
  const didRun = useRef(false);
  const setImported = useDataStore((state) => state.setImported);
  const setSubscriptions = useDataStore((state) => state.setSubscriptions);
  const setTrafficMetrics = useDataStore((state) => state.setTrafficMetrics);
  const [status, setStatus] = useState<AutoLoadStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (didRun.current) return;
    didRun.current = true;

    let mounted = true;

    async function restoreSavedData() {
      setStatus("loading");
      setMessage("Loading saved data...");

      const warnings: string[] = [];
      const details: string[] = [];
      let loadedCount = 0;

      try {
        if (useDataStore.getState().meta.source !== "mock") {
          details.push("Palmer dataset already loaded");
          throw new Error("__skip__");
        }

        let cached: PalmerDatasetCachePayload | null = null;
        let source: RestoreSource = "local cache";
        try {
          cached = await loadLastPalmerDatasetFromCache();
        } catch (error) {
          console.warn("Could not read Palmer IndexedDB cache.", error);
          warnings.push("Palmer local cache");
        }

        if (!cached) {
          const cloud = await loadLatestCloudSnapshot<PalmerCloudPayload>("palmer").catch((error) => {
            console.warn("Could not read Palmer cloud snapshot.", error);
            warnings.push("Palmer cloud snapshot");
            return null;
          });
          const payload = normalizePalmerCloudPayload(cloud?.payload);
          const transactions = payload?.transactions;
          if (transactions?.length) {
            cached = {
              transactions,
              users: [],
              cohorts: [],
              rawPalmerRows: payload.rawPalmerRows,
              metadata: {
                file_name: String(cloud.metadata.file_name ?? cloud.name ?? "Palmer import"),
                imported_at: String(cloud.metadata.imported_at ?? cloud.updated_at),
                rows_count: Number(cloud.metadata.rows_count ?? payload.rawPalmerRows?.length ?? transactions.length),
                transactions_count: Number(cloud.metadata.transactions_count ?? transactions.length),
                cohorts_count: Number(cloud.metadata.cohorts_count ?? 0),
                users_count: Number(cloud.metadata.users_count ?? 0),
                source: "palmer_import",
              },
            };
            void savePalmerDatasetToCache(
              { transactions, rawPalmerRows: payload.rawPalmerRows },
              cached.metadata,
            ).catch((error) => console.warn("Could not warm Palmer IndexedDB cache.", error));
            source = "cloud";
          }
        }

        if (cached && mounted && useDataStore.getState().meta.source === "mock") {
          setImported(
            cached.transactions,
            {
              source: "palmer_raw",
              importMode: "palmer_raw",
              fileName: cached.metadata.file_name,
            },
            cached.rawPalmerRows ?? [],
          );
          loadedCount += 1;
          details.push(`Loaded Palmer dataset from ${source}`);
        } else if (!cached) {
          details.push("No saved Palmer dataset found");
        }
      } catch (error) {
        if (error instanceof Error && error.message === "__skip__") {
          // A user-loaded Palmer dataset is already in memory; keep it.
        } else {
          console.warn("Could not restore Palmer dataset.", error);
          warnings.push("Palmer dataset");
        }
      }

      try {
        if (useDataStore.getState().subscriptions.length > 0) {
          details.push("FunnelFox subscriptions already loaded");
          throw new Error("__skip__");
        }

        let cached: SubscriptionCachePayload | null = null;
        let source: RestoreSource = "local cache";
        try {
          cached = await loadSubscriptionsFromCache();
        } catch (error) {
          console.warn("Could not read FunnelFox IndexedDB cache.", error);
          warnings.push("FunnelFox local cache");
        }

        if (!cached) {
          const cloud = await loadLatestCloudSnapshot<SubscriptionsCloudPayload>("funnelfox_subscriptions").catch((error) => {
            console.warn("Could not read FunnelFox cloud snapshot.", error);
            warnings.push("FunnelFox cloud snapshot");
            return null;
          });
          const subscriptions = cloud?.payload.subscriptions;
          if (subscriptions?.length) {
            cached = {
              subscriptions,
              metadata: {
                saved_at: String(cloud.metadata.saved_at ?? cloud.updated_at),
                count: Number(cloud.metadata.count ?? subscriptions.length),
                source: "funnelfox",
                email_coverage: Number(cloud.metadata.email_coverage ?? 0),
                last_sync_at: String(cloud.metadata.last_sync_at ?? cloud.updated_at),
              },
            };
            void saveSubscriptionsToCache(subscriptions, cached.metadata).catch((error) =>
              console.warn("Could not warm FunnelFox IndexedDB cache.", error),
            );
            source = "cloud";
          }
        }

        if (cached && mounted && useDataStore.getState().subscriptions.length === 0) {
          setSubscriptions(cached.subscriptions);
          loadedCount += 1;
          details.push(`Loaded FunnelFox subscriptions from ${source}`);
        } else if (!cached) {
          details.push("No saved FunnelFox subscriptions found");
        }
      } catch (error) {
        if (error instanceof Error && error.message === "__skip__") {
          // Keep already-loaded subscriptions.
        } else {
          console.warn("Could not restore FunnelFox subscriptions.", error);
          warnings.push("FunnelFox subscriptions");
        }
      }

      try {
        if (useDataStore.getState().trafficMetrics.length > 0) {
          details.push("Facebook traffic already loaded");
          throw new Error("__skip__");
        }

        let cached: TrafficCachePayload | null = null;
        let source: RestoreSource = "local cache";
        try {
          cached = await loadLastTrafficDataFromCache();
        } catch (error) {
          console.warn("Could not read Facebook traffic IndexedDB cache.", error);
          warnings.push("Facebook traffic local cache");
        }

        if (!cached) {
          const cloud = await loadLatestCloudSnapshot<TrafficCloudPayload>("facebook_traffic").catch((error) => {
            console.warn("Could not read Facebook traffic cloud snapshot.", error);
            warnings.push("Facebook traffic cloud snapshot");
            return null;
          });
          const trafficMetrics = cloud?.payload.trafficMetrics;
          if (trafficMetrics?.length) {
            cached = {
              trafficMetrics,
              metadata: {
                source: "facebook_traffic",
                google_sheet_url: typeof cloud.metadata.google_sheet_url === "string" ? cloud.metadata.google_sheet_url : undefined,
                imported_at: String(cloud.metadata.imported_at ?? cloud.updated_at),
                rows_count: Number(cloud.metadata.rows_count ?? trafficMetrics.length),
                matched_rows_count:
                  typeof cloud.metadata.matched_rows_count === "number" ? cloud.metadata.matched_rows_count : undefined,
                year: typeof cloud.metadata.year === "number" ? cloud.metadata.year : undefined,
              },
            };
            void saveTrafficDataToCache(trafficMetrics, cached.metadata).catch((error) =>
              console.warn("Could not warm Facebook traffic IndexedDB cache.", error),
            );
            source = "cloud";
          }
        }

        if (cached && mounted && useDataStore.getState().trafficMetrics.length === 0) {
          setTrafficMetrics(cached.trafficMetrics);
          loadedCount += 1;
          details.push(`Loaded Facebook traffic from ${source}`);
        } else if (!cached) {
          details.push("No saved Facebook traffic found");
        }
      } catch (error) {
        if (error instanceof Error && error.message === "__skip__") {
          // Keep already-loaded traffic metrics.
        } else {
          console.warn("Could not restore Facebook traffic.", error);
          warnings.push("Facebook traffic");
        }
      }

      try {
        if (localStorage.getItem(FORECASTING_DEFAULT_RETENTION_KEY)) {
          details.push("Forecasting settings already loaded");
          throw new Error("__skip__");
        }

        const cloud = await loadLatestCloudSnapshot<ForecastingCloudPayload>("forecasting_settings").catch((error) => {
          console.warn("Could not read forecasting settings cloud snapshot.", error);
          warnings.push("Forecasting settings cloud snapshot");
          return null;
        });
        if (cloud?.payload.retention_curve) {
          saveDefaultRetentionCurve(cloud.payload.retention_curve);
          loadedCount += 1;
          details.push("Loaded Forecasting settings from cloud");
        } else {
          details.push("No saved Forecasting settings found");
        }
      } catch (error) {
        if (error instanceof Error && error.message === "__skip__") {
          // Keep local forecasting settings.
        } else {
          console.warn("Could not restore forecasting settings.", error);
          warnings.push("Forecasting settings");
        }
      }

      if (!mounted) return;

      if (warnings.length) {
        console.warn(`Could not restore saved data from cache: ${warnings.join(", ")}.`);
        setStatus("warning");
        setMessage(
          loadedCount
            ? `Saved data loaded with warnings: ${warnings.join(", ")}. ${details.join(". ")}.`
            : `Could not load saved data: ${warnings.join(", ")}. ${details.join(". ")}.`,
        );
        window.setTimeout(() => {
          if (mounted) setStatus("idle");
        }, 5000);
        return;
      }

      if (loadedCount) {
        setStatus("loaded");
        setMessage(details.join(". "));
        window.setTimeout(() => {
          if (mounted) setStatus("idle");
        }, 5000);
        return;
      }

      setStatus("loaded");
      setMessage(details.length ? details.join(". ") : "No saved dataset found");
      window.setTimeout(() => {
        if (mounted) setStatus("idle");
      }, 4000);
    }

    void restoreSavedData();

    return () => {
      mounted = false;
    };
  }, [setImported, setSubscriptions, setTrafficMetrics]);

  if (status === "idle" || !message) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 max-w-md rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground shadow-card"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        {status === "loading" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        <span>{message}</span>
      </div>
    </div>
  );
}
