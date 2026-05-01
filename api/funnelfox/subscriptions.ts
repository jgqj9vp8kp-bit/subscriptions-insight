/* global process */

import { handleFunnelFoxSubscriptions } from "./subscriptionsCore";

type ApiRequest = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): ApiResponse;
  json(body: unknown): void;
};

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function getRequestUrl(req: ApiRequest): URL {
  const host = firstQueryValue(req.headers?.host) ?? "localhost";
  return new URL(req.url ?? "/api/funnelfox/subscriptions", `https://${host}`);
}

function getCursor(req: ApiRequest): string | undefined {
  const queryCursor = firstQueryValue(req.query?.cursor);
  if (queryCursor) return queryCursor;

  const url = getRequestUrl(req);
  return url.searchParams.get("cursor") ?? undefined;
}

function getDebug(req: ApiRequest): boolean {
  const queryDebug = firstQueryValue(req.query?.debug);
  if (queryDebug) return queryDebug === "1" || queryDebug === "true";

  const url = getRequestUrl(req);
  const debug = url.searchParams.get("debug");
  return debug === "1" || debug === "true";
}

function getHeader(req: ApiRequest, name: string): string | undefined {
  const target = name.toLowerCase();
  const entry = Object.entries(req.headers ?? {}).find(([key]) => key.toLowerCase() === target);
  return firstQueryValue(entry?.[1])?.trim() || undefined;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method && req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  res.setHeader("Cache-Control", "no-store");
  const result = await handleFunnelFoxSubscriptions({
    cursor: getCursor(req),
    debug: getDebug(req),
    secret: process.env.FUNNELFOX_SECRET || getHeader(req, "X-FunnelFox-Secret"),
  });
  return res.status(result.status).json(result.body);
}
