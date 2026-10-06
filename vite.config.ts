import { defineConfig, loadEnv } from "vite";
import type { Plugin, ViteDevServer } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import {
  FUNNELFOX_LOCAL_PROXY_FLAG,
  handleFunnelFoxProfile,
  handleFunnelFoxProfileDebug,
  handleFunnelFoxSubscriptionDetails,
  handleFunnelFoxSubscriptions,
} from "./api/funnelfox/subscriptionsCore";

// Dev server hosts that only this machine can reach.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// Dev-only FunnelFox proxy. The handlers return raw upstream payloads (customer
// emails) to any valid session, so they refuse to run unless
// FUNNELFOX_LOCAL_PROXY_ENABLED=true. That flag is switched on here, inside
// configureServer — which only `vite` (the dev server) calls; `vite build` and
// `vite preview` never do — and only when the dev server listens on loopback.
// The default bind is "::" (the Lovable editor preview needs it), so on a
// network-reachable dev server the proxy stays off unless the developer sets
// the flag explicitly; an explicit value always wins.
function funnelFoxDevProxy(): Plugin {
  return {
    name: "funnelfox-dev-proxy",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      if (process.env[FUNNELFOX_LOCAL_PROXY_FLAG] === undefined && LOOPBACK_HOSTS.has(String(server.config.server.host))) process.env[FUNNELFOX_LOCAL_PROXY_FLAG] = "true";
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
      // "::" is the Lovable template default (its editor preview reaches the dev
      // server over the network). The FunnelFox dev proxy is NOT enabled on this
      // bind — see funnelFoxDevProxy; run `npm run dev -- --host localhost` to
      // use it locally.
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
