import { type AdminActor, assertCapability } from "../admin/capabilities.ts";
import { INITIAL_STATUS, parseStatus, type SystemStatus } from "./policy.ts";

export interface MaintenanceHistory {
  at: string;
  actorId: number;
  reason: string;
  before: SystemStatus;
  after: SystemStatus;
}
export function maintenanceOrigin(): string | null {
  const raw = process.env.MAINTENANCE_SERVICE_URL;
  if (!raw) return null;
  const url = new URL(raw);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("MAINTENANCE_SERVICE_URL geçerli bir HTTPS kökeni olmalı.");
  }
  return url.origin;
}

/** No shared-memory cache: every instance observes the independent source. */
export async function readSystemStatus(): Promise<SystemStatus | null> {
  try {
    const origin = maintenanceOrigin();
    if (!origin) return { ...INITIAL_STATUS, services: [] };
    const response = await fetch(`${origin}/status`, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    return parseStatus(await response.json());
  } catch {
    return null;
  }
}

async function adminRequest(method: "GET" | "PUT", body?: unknown): Promise<Response> {
  const origin = maintenanceOrigin();
  const token = process.env.MAINTENANCE_ADMIN_TOKEN;
  if (!origin || !token || token.length < 32)
    throw new Error("Bakım servisi henüz yapılandırılmadı.");
  return fetch(`${origin}/admin/status`, {
    method,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function readMaintenanceAdmin(actor: AdminActor): Promise<{
  status: SystemStatus;
  history: MaintenanceHistory[];
}> {
  assertCapability(actor, "maintenance.read");
  const response = await adminRequest("GET");
  if (!response.ok) throw new Error("Bakım servisine ulaşılamıyor.");
  const value = (await response.json()) as { status: unknown; history: MaintenanceHistory[] };
  return { status: parseStatus(value.status), history: value.history };
}

export async function updateMaintenance(actor: AdminActor, input: unknown): Promise<SystemStatus> {
  assertCapability(actor, "maintenance.manage");
  if (!input || typeof input !== "object") throw new Error("Geçersiz istek.");
  const value = input as Record<string, unknown>;
  const status = parseStatus(value.status);
  if (
    typeof value.reason !== "string" ||
    value.reason.trim().length < 5 ||
    value.reason.trim().length > 500
  ) {
    throw new Error("5–500 karakterlik işlem gerekçesi gir.");
  }
  const response = await adminRequest("PUT", {
    status,
    reason: value.reason.trim(),
    actorId: actor.userId,
  });
  if (response.status === 409)
    throw new Error("Durum başka bir yönetici tarafından değiştirildi. Sayfayı yenile.");
  if (!response.ok)
    throw new Error("Değişiklik doğrulanamadı. Güncel durumu kontrol etmeden tekrar kaydetme.");
  return parseStatus(await response.json());
}
