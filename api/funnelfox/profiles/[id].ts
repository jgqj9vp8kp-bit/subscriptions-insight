/* global process */

import { handleFunnelFoxProfile } from "../subscriptionsCore";

type ApiRequest = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
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
  const result = await handleFunnelFoxProfile({
    profileId: firstQueryValue(req.query?.id) ?? "",
    secret: process.env.FUNNELFOX_SECRET || getHeader(req, "X-FunnelFox-Secret"),
  });
  return res.status(result.status).json(result.body);
}
