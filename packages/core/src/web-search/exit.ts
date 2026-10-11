/**
 * Internet sonucundan magaza cikisi (docs/decisions/0102, CLAUDE.md kural 8).
 *
 * Katalogda `offer` satiri olmayan sonuc icin `/git/web/<token>` kullanilir.
 * Token, sunucu tarafindan imzalanir (`SESSION_SECRET` ile HMAC) ve hedef
 * adresi, eslesme turunu, dogrulanmis fiyati ve yuzeyi tasir. Boylece:
 * - yonlendirme "acik yonlendirme" olamaz: yalnizca sunucunun urettigi, suresi
 *   dolmamis ve guvenli adreslere gider;
 * - fiyat ve tur istemciden gelen serbest deger degildir;
 * - her cikis `web_exit_click` defterine yazilir (affiliate DEGILDIR; `click`
 *   ve donusum akisina dokunulmaz).
 */
import { timingSafeEqual } from "node:crypto";
import { type Database, webExitClick } from "@arilla/db";
import { pseudonymize } from "../auth/token.ts";
import { WEB_EXIT_TOKEN_TTL_SECONDS } from "./config.ts";
import type { WebMatchKind, WebPriceStatus } from "./types.ts";
import { toSafePublicUrl } from "./url-safety.ts";

export type WebExitSurface = "search" | "visual" | "link" | "chat";
const SURFACES: readonly WebExitSurface[] = ["search", "visual", "link", "chat"];

export interface WebExitPayload {
  url: string;
  kind: WebMatchKind;
  /** Kurus; yalnizca dogrulanmis fiyat. */
  price: number | null;
  priceStatus: WebPriceStatus;
  surface: WebExitSurface;
  /** 1..500 liste sirasi. */
  position: number | null;
}

interface Wire {
  u: string;
  k: "e" | "s";
  p: number | null;
  v: 0 | 1;
  s: string;
  n: number | null;
  x: number;
}

function mac(body: string): string {
  return pseudonymize("webexit", body).slice(0, 40);
}

export function signWebExit(
  payload: WebExitPayload,
  now: Date = new Date(),
  ttlSeconds: number = WEB_EXIT_TOKEN_TTL_SECONDS,
): string {
  const wire: Wire = {
    u: payload.url,
    k: payload.kind === "exact" ? "e" : "s",
    p: payload.price,
    v: payload.priceStatus === "verified" ? 1 : 0,
    s: payload.surface,
    n: payload.position,
    x: Math.floor(now.getTime() / 1000) + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(wire), "utf8").toString("base64url");
  return `${body}.${mac(body)}`;
}

export function verifyWebExit(token: string, now: Date = new Date()): WebExitPayload | null {
  if (typeof token !== "string" || token.length > 4096) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = mac(body);
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let wire: Wire;
  try {
    wire = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Wire;
  } catch {
    return null;
  }
  if (typeof wire !== "object" || wire === null) return null;
  if (typeof wire.x !== "number" || wire.x < Math.floor(now.getTime() / 1000)) return null;
  // Imzali olsa da tekrar dogrula: guvenli ve kanonik adres degilse yonlendirme yok.
  const safe = toSafePublicUrl(wire.u);
  if (safe === null || safe.url !== wire.u) return null;
  if (!SURFACES.includes(wire.s as WebExitSurface)) return null;
  const price =
    wire.v === 1 && Number.isSafeInteger(wire.p) && (wire.p as number) >= 0 ? wire.p : null;
  const position =
    Number.isInteger(wire.n) && (wire.n as number) >= 1 && (wire.n as number) <= 500
      ? wire.n
      : null;
  return {
    url: safe.url,
    kind: wire.k === "e" ? "exact" : "similar",
    price,
    priceStatus: price === null ? "unverified" : "verified",
    surface: wire.s as WebExitSurface,
    position,
  };
}

export interface RecordWebExitInput {
  payload: WebExitPayload;
  sessionId: string;
  userId: number | null;
}

/** Cikis defterine yazar; yonlendirmeden ONCE cagrilir (kural 8). */
export async function recordWebExit(
  db: Database,
  input: RecordWebExitInput,
): Promise<{ clickId: string }> {
  const safe = toSafePublicUrl(input.payload.url);
  if (safe === null) throw new Error("web exit: unsafe url");
  const [row] = await db
    .insert(webExitClick)
    .values({
      userId: input.userId,
      sessionId: input.sessionId,
      host: safe.host,
      url: safe.url,
      matchKind: input.payload.kind,
      priceAtClick: input.payload.price,
      priceStatus: input.payload.priceStatus,
      surface: input.payload.surface,
      resultPosition: input.payload.position,
    })
    .returning({ id: webExitClick.id });
  if (!row) throw new Error("web exit: insert failed");
  return { clickId: row.id };
}

/** Sayfa disina verilecek yol: yalnizca `/git/web/<token>`. */
export function webExitHref(token: string): string {
  return `/git/web/${token}`;
}
