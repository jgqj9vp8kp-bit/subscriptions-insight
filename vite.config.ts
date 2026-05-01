import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { handleFunnelFoxProfile, handleFunnelFoxProfileDebug, handleFunnelFoxSubscriptionDetails, handleFunnelFoxSubscriptions } from "./api/funnelfox/subscriptionsCore";

function funnelFoxDevProxy(secret?: string) {
  return {
    name: "funnelfox-dev-proxy",
    configureServer(server) {
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

        const resolvedSecret = secret || req.headers["x-funnelfox-secret"]?.toString().trim();
        const result = profileMatch
          ? await handleFunnelFoxProfile({
              profileId: decodeURIComponent(profileMatch[1]),
              secret: resolvedSecret,
            })
          : isSubscriptionDetailsRoute
            ? await handleFunnelFoxSubscriptionDetails({
                subscriptionId: requestUrl.searchParams.get("id") ?? "",
                secret: resolvedSecret,
              })
          : isProfileDebugRoute
            ? await handleFunnelFoxProfileDebug({
                profileId: requestUrl.searchParams.get("id") ?? "",
                secret: resolvedSecret,
              })
          : await handleFunnelFoxSubscriptions({
              cursor: requestUrl.searchParams.get("cursor") ?? undefined,
              debug: ["1", "true"].includes(requestUrl.searchParams.get("debug") ?? ""),
              secret: resolvedSecret,
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
  const funnelFoxSecret = env.FUNNELFOX_SECRET || process.env.FUNNELFOX_SECRET;

  return {
    server: {
      host: "::",
      port: 8080,
      hmr: {
        overlay: false,
      },
    },
    plugins: [react(), funnelFoxDevProxy(funnelFoxSecret), mode === "development" && componentTagger()].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
    },
  };
});
