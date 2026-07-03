import { defineConfig, loadEnv } from "vite";
import type { ViteDevServer } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { handleFunnelFoxProfile, handleFunnelFoxProfileDebug, handleFunnelFoxSubscriptionDetails, handleFunnelFoxSubscriptions } from "./api/funnelfox/subscriptionsCore";

function funnelFoxDevProxy() {
  return {
    name: "funnelfox-dev-proxy",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url ?? "/", "http://localhost");
        const isSubscriptionsRoute = requestUrl.pathname === "/api/funnelfox/subscriptions";
        const isSubscriptionDetailsRoute = requestUrl.pathname === "/api/funnelfox/subscription";
        const isProfileDebugRoute = requestUrl.pathname === "/api/funnelfox/profile";
        const profileMatch = requestUrl.pathname.match(/^\/api\/funnelfox\/profiles\/([^/]+)$/);

        if (!isSubscriptionsRoute && !isSubscriptionDetailsRoute && !isProfileDebugRoute && !profileMatch) {
          return next();
        }

        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");

        if (req.method && req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          res.end(JSON.stringify({ error: "Method not allowed." }));
          return;
        }

        const authHeader = req.headers["authorization"]?.toString();
        const result = profileMatch
          ? await handleFunnelFoxProfile({
              profileId: decodeURIComponent(profileMatch[1]),
              authHeader,
            })
          : isSubscriptionDetailsRoute
            ? await handleFunnelFoxSubscriptionDetails({
                subscriptionId: requestUrl.searchParams.get("id") ?? "",
                authHeader,
              })
          : isProfileDebugRoute
            ? await handleFunnelFoxProfileDebug({
                profileId: requestUrl.searchParams.get("id") ?? "",
                authHeader,
              })
          : await handleFunnelFoxSubscriptions({
              cursor: requestUrl.searchParams.get("cursor") ?? undefined,
              debug: ["1", "true"].includes(requestUrl.searchParams.get("debug") ?? ""),
              authHeader,
            });

        res.statusCode = result.status;
        res.end(JSON.stringify(result.body));
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    server: {
      host: "::",
      port: 8080,
      hmr: {
        overlay: false,
      },
    },
    plugins: [react(), funnelFoxDevProxy(), mode === "development" && componentTagger()].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
    },
    build: {
      rollupOptions: {
        output: {
          // Split large, rarely-changing vendor libraries into their own long-cached chunks so the
          // main app chunk shrinks and the browser can download them in parallel. recharts (the
          // single biggest dependency) is isolated so only chart-using pages pay for it.
          manualChunks: {
            "vendor-react": ["react", "react-dom", "react-router-dom"],
            "vendor-charts": ["recharts"],
            "vendor-supabase": ["@supabase/supabase-js"],
            "vendor-query": ["@tanstack/react-query"],
          },
        },
      },
    },
  };
});
