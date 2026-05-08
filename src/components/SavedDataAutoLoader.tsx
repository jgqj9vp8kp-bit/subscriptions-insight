import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { loadLastPalmerDatasetFromCache } from "@/services/palmerCache";
import { loadSubscriptionsFromCache } from "@/services/subscriptionCache";
import { loadLastTrafficDataFromCache } from "@/services/trafficCache";
import { useDataStore } from "@/store/dataStore";

type AutoLoadStatus = "idle" | "loading" | "loaded" | "warning";

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
      let loadedCount = 0;

      const [palmerResult, subscriptionsResult, trafficResult] = await Promise.allSettled([
        loadLastPalmerDatasetFromCache(),
        loadSubscriptionsFromCache(),
        loadLastTrafficDataFromCache(),
      ]);

      if (!mounted) return;

      if (palmerResult.status === "fulfilled" && palmerResult.value) {
        const cached = palmerResult.value;
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
      } else if (palmerResult.status === "rejected") {
        warnings.push("Palmer dataset");
      }

      if (subscriptionsResult.status === "fulfilled" && subscriptionsResult.value) {
        setSubscriptions(subscriptionsResult.value.subscriptions);
        loadedCount += 1;
      } else if (subscriptionsResult.status === "rejected") {
        warnings.push("FunnelFox subscriptions");
      }

      if (trafficResult.status === "fulfilled" && trafficResult.value) {
        setTrafficMetrics(trafficResult.value.trafficMetrics);
        loadedCount += 1;
      } else if (trafficResult.status === "rejected") {
        warnings.push("Facebook traffic");
      }

      if (!mounted) return;

      if (warnings.length) {
        console.warn(`Could not restore saved data from cache: ${warnings.join(", ")}.`);
        setStatus("warning");
        setMessage(
          loadedCount
            ? `Saved data loaded with warnings: ${warnings.join(", ")}.`
            : `Could not load saved data: ${warnings.join(", ")}.`,
        );
        window.setTimeout(() => {
          if (mounted) setStatus("idle");
        }, 5000);
        return;
      }

      if (loadedCount) {
        setStatus("loaded");
        setMessage("Saved data restored");
        window.setTimeout(() => {
          if (mounted) setStatus("idle");
        }, 2500);
        return;
      }

      setStatus("idle");
      setMessage(null);
    }

    void restoreSavedData();

    return () => {
      mounted = false;
    };
  }, [setImported, setSubscriptions, setTrafficMetrics]);

  if (status === "idle" || !message) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground shadow-card"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        {status === "loading" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        <span>{message}</span>
      </div>
    </div>
  );
}
