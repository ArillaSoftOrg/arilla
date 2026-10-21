/** No database, Redis, framework or third-party imports: also runs at the edge. */
export const MODES = {
  normal: "Normal çalışma",
  planned: "Planlı bakım duyurusu",
  partial: "Kısmi kesinti",
  maintenance: "Tam bakım",
} as const;

export const SERVICES = {
  search: "Ürün arama",
  image: "Görselle arama",
  link: "Linkle arama",
  chat: "AI sohbet",
  account: "Hesap ve giriş",
  alerts: "Fiyat alarmları",
} as const;
export type Mode = keyof typeof MODES;
export type Service = keyof typeof SERVICES;
export interface SystemStatus {
  mode: Mode;
  message: string;
  estimatedEnd: string | null;
  services: Service[];
  version: number;
  updatedAt: string | null;
}
export const INITIAL_STATUS: SystemStatus = {
  mode: "normal",
  message: "",
  estimatedEnd: null,
  services: [],
  version: 0,
  updatedAt: null,
};

export function parseStatus(value: unknown): SystemStatus {
  if (!value || typeof value !== "object") throw new Error("Geçersiz durum bilgisi.");
  const v = value as Record<string, unknown>;
  if (typeof v.mode !== "string" || !Object.hasOwn(MODES, v.mode)) throw new Error("Geçersiz mod.");
  if (
    typeof v.message !== "string" ||
    v.message.trim().length > 1500 ||
    (v.mode !== "normal" && !v.message.trim())
  )
    throw new Error("Bakım mesajı 1–1500 karakter olmalı.");
  if (
    !Array.isArray(v.services) ||
    v.services.length > Object.keys(SERVICES).length ||
    v.services.some((s) => typeof s !== "string" || !Object.hasOwn(SERVICES, s)) ||
    new Set(v.services).size !== v.services.length
  )
    throw new Error("Geçersiz hizmet listesi.");
  if (v.mode === "partial" && v.services.length === 0) throw new Error("Etkilenen hizmetleri seç.");
  if (
    v.estimatedEnd !== null &&
    (typeof v.estimatedEnd !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v.estimatedEnd) ||
      !Number.isFinite(Date.parse(v.estimatedEnd)))
  )
    throw new Error("Geçersiz tahmini bitiş zamanı.");
  if (!Number.isSafeInteger(v.version) || (v.version as number) < 0)
    throw new Error("Geçersiz sürüm.");
  if (
    v.updatedAt !== null &&
    (typeof v.updatedAt !== "string" || !Number.isFinite(Date.parse(v.updatedAt)))
  ) {
    throw new Error("Geçersiz güncelleme zamanı.");
  }
  return {
    mode: v.mode as Mode,
    message: v.mode === "normal" ? "" : v.message.trim(),
    estimatedEnd: v.mode === "normal" ? null : (v.estimatedEnd as string | null),
    services: v.mode === "normal" ? [] : (v.services as Service[]),
    version: v.version as number,
    updatedAt: v.updatedAt as string | null,
  };
}

const PREFIXES: Record<Service, readonly string[]> = {
  search: ["/ara"],
  image: ["/ara/gorsel"],
  link: ["/ara/link"],
  chat: ["/sohbet"],
  account: ["/hesap", "/giris", "/kayit"],
  alerts: ["/alarmlar"],
};
function under(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Admin/API administration, callbacks, jobs and machine health remain reachable. */
export function bypassMaintenance(path: string): boolean {
  return [
    "/yonetim",
    "/api/yonetim",
    "/giris/yonetim",
    "/giris/google",
    "/api/cron",
    "/api/health",
    "/api/system-status",
    "/durum",
    "/_next",
    "/_maintenance",
  ].some((p) => under(path, p));
}
export function isBlocked(status: SystemStatus, path: string): boolean {
  if (bypassMaintenance(path)) return false;
  if (status.mode === "maintenance") return true;
  return (
    status.mode === "partial" &&
    status.services.some((s) => PREFIXES[s].some((p) => under(path, p)))
  );
}
export function safeReturnPath(value: string | null | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//") || /[\\\r\n]/.test(value)) return "/";
  try {
    const url = new URL(value, "https://local.invalid");
    if (url.origin !== "https://local.invalid" || bypassMaintenance(url.pathname)) return "/";
    return url.pathname; // Do not propagate login tokens or user query strings.
  } catch {
    return "/";
  }
}
