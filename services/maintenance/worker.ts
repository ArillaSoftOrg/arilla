import {
  MAINTENANCE_HEADERS,
  maintenanceDocument,
} from "../../packages/core/src/maintenance/document.ts";
import {
  INITIAL_STATUS,
  isBlocked,
  parseStatus,
  type SystemStatus,
  safeReturnPath,
} from "../../packages/core/src/maintenance/policy.ts";

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  transaction<T>(fn: (tx: Storage) => Promise<T>): Promise<T>;
}
interface Env {
  STATUS: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  ADMIN_TOKEN: string;
  APP_URL: string;
  /** Optional origin hostname, DIFFERENT from the public gateway hostname. */
  GATEWAY_ORIGIN?: string;
  /** Cloudflare Route mode: same-zone fetch goes directly to the existing DNS origin. */
  GATEWAY_PASSTHROUGH?: string;
}
type Entry = {
  at: string;
  actorId: number;
  reason: string;
  before: SystemStatus;
  after: SystemStatus;
};
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

/** One strongly consistent object; status and audit history commit together. */
export class MaintenanceState {
  private storage: Storage;
  constructor(ctx: { storage: Storage }) {
    this.storage = ctx.storage;
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") {
      return json((await this.storage.get("state")) ?? { status: INITIAL_STATUS, history: [] });
    }
    if (request.method !== "PUT") return json({ error: "method" }, 405);
    let input: { status: SystemStatus; actorId: number; reason: string };
    try {
      const raw = await request.text();
      if (raw.length > 12000) return json({ error: "size" }, 413);
      input = JSON.parse(raw);
      input.status = parseStatus(input.status);
      if (
        !Number.isSafeInteger(input.actorId) ||
        input.actorId < 1 ||
        typeof input.reason !== "string" ||
        input.reason.trim().length < 5 ||
        input.reason.length > 500
      )
        throw new Error();
    } catch {
      return json({ error: "validation" }, 400);
    }
    return this.storage.transaction(async (tx) => {
      const state = (await tx.get<{ status: SystemStatus; history: Entry[] }>("state")) ?? {
        status: INITIAL_STATUS,
        history: [],
      };
      if (state.status.version !== input.status.version) return json({ error: "conflict" }, 409);
      const at = new Date().toISOString();
      const status = { ...input.status, version: state.status.version + 1, updatedAt: at };
      const history = [
        {
          at,
          actorId: input.actorId,
          reason: input.reason.trim(),
          before: state.status,
          after: status,
        },
        ...state.history,
      ].slice(0, 100);
      await tx.put("state", { status, history });
      return json(status);
    });
  }
}

async function authorized(request: Request, secret: string): Promise<boolean> {
  if (!secret || secret.length < 32) return false;
  const token = request.headers.get("authorization") ?? "";
  // Fixed-length digest comparison avoids early-return comparison of the secret.
  const digest = async (v: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  const [a, b] = await Promise.all([digest(token), digest(`Bearer ${secret}`)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
function origin(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid origin");
  return url.origin;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const appOrigin = origin(env.APP_URL || "https://manicepte.com");
    const state = env.STATUS?.get(env.STATUS.idFromName("manicepte-system-status"));
    const admin = path === "/admin/status";
    if (admin) {
      if (!(await authorized(request, env.ADMIN_TOKEN)))
        return json({ error: "unauthorized" }, 401);
      if (!["GET", "PUT"].includes(request.method)) return json({ error: "method" }, 405);
      if (!state) return json({ error: "unavailable" }, 503);
      try {
        return await state.fetch(new Request("https://state.internal/", request));
      } catch {
        return json({ error: "unavailable" }, 503);
      }
    }
    let status: SystemStatus | null = null;
    try {
      const response = await state?.fetch(new Request("https://state.internal/"));
      if (response?.ok)
        status = parseStatus(((await response.json()) as { status: unknown }).status);
    } catch {
      /* Unknown is never represented as normal. */
    }

    if ((path === "/status" && url.origin !== appOrigin) || path === "/api/system-status") {
      if (!["GET", "HEAD"].includes(request.method)) return json({ error: "method" }, 405);
      return status
        ? json({
            ...status,
            blocked: isBlocked(status, safeReturnPath(url.searchParams.get("path"))),
          })
        : json({ error: "unavailable" }, 503);
    }
    const gateway = env.GATEWAY_ORIGIN ? origin(env.GATEWAY_ORIGIN) : null;
    const passthrough = env.GATEWAY_PASSTHROUGH === "true" && gateway === appOrigin;
    if (gateway === url.origin && !passthrough) return json({ error: "recursive_origin" }, 503);
    if (path === "/_maintenance/recovery") {
      if (!gateway)
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      try {
        const r = await fetch(`${gateway}/api/health`, {
          redirect: "manual",
          signal: AbortSignal.timeout(4000),
        });
        return new Response(null, {
          status: r.ok ? 204 : 503,
          headers: { "cache-control": "no-store" },
        });
      } catch {
        return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
      }
    }
    const document = (current: SystemStatus | null, always = false) => {
      const target = always ? safeReturnPath(url.searchParams.get("next")) : safeReturnPath(path);
      return new Response(
        maintenanceDocument({
          status: current,
          statusUrl: "/api/system-status",
          returnPath: target,
          appOrigin,
          autoReturn: !always || url.searchParams.has("next"),
          recoveryUrl: "/_maintenance/recovery",
        }),
        {
          status: always ? 200 : 503,
          headers: MAINTENANCE_HEADERS,
        },
      );
    };
    if (
      (path === "/" && (!gateway || (passthrough && url.origin !== appOrigin))) ||
      path === "/durum"
    )
      return document(status, true);
    if (passthrough && url.origin !== appOrigin) return json({ error: "not_found" }, 404);
    if (status && isBlocked(status, path)) {
      if (
        request.method !== "GET" ||
        path.startsWith("/api/") ||
        request.headers.get("rsc") === "1"
      ) {
        return json({ error: "maintenance", ...status }, 503);
      }
      return document(status);
    }
    if (!gateway) return json({ error: "not_found" }, 404);
    // The gateway keeps serving the maintenance document if the application is down.
    try {
      const upstream = new URL(request.url);
      const backend = new URL(gateway);
      upstream.host = backend.host;
      upstream.protocol = backend.protocol;
      const headers = new Headers(request.headers);
      headers.set("x-forwarded-host", url.host);
      const response = await fetch(new Request(upstream, new Request(request, { headers })), {
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      });
      if (
        response.status >= 500 &&
        request.method === "GET" &&
        request.headers.get("accept")?.includes("text/html") &&
        !path.startsWith("/yonetim")
      )
        return document(null);
      return response;
    } catch {
      if (request.method === "GET" && request.headers.get("accept")?.includes("text/html"))
        return document(null);
      return json({ error: "origin_unavailable" }, 503);
    }
  },
};
