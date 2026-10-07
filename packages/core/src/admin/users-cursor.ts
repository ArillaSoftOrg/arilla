/**
 * Kullanıcı listesi ve ayrıntı sekmeleri için keyset imleci (karar 0049
 * §1b). İmleç istemciye opak bir dizedir: `base64url("<yön>|<zaman>|<kimlik>")`.
 *
 * - Zaman, Postgres'ten METİN olarak mikrosaniye hassasiyetle alınır
 *   (`keysetAtSql`). JS `Date` milisaniyeye yuvarlar; zaman imleci
 *   yuvarlanırsa aynı milisaniyedeki satırlar atlanır ya da tekrarlanır
 *   (aynı tuzak: `audit.ts` `beforeId` notu).
 * - Çözme katıdır: biçim, gerçek tarih, kimlik türü ve uzunluk denetlenir.
 *   Geçersiz imleç `null` döner; çağıran ilk sayfayı gösterir. İmleç asla
 *   SQL'e metin olarak eklenmez, yalnızca parametre olur.
 */
import { type SQL, sql } from "drizzle-orm";

/** `a` = imleçten SONRAKİ sayfa (daha eski), `b` = imleçten ÖNCEKİ sayfa (daha yeni). */
export type KeysetDirection = "a" | "b";
export type KeysetIdKind = "int" | "uuid";

export interface KeysetCursor {
  direction: KeysetDirection;
  /** UTC, mikrosaniyeli: `2026-10-03T08:15:42.123456Z`. */
  at: string;
  /** `int`: pozitif güvenli tamsayı (metin). `uuid`: küçük harfli UUID. */
  id: string;
}

const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const INT_PATTERN = /^[1-9]\d{0,15}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CURSOR_LENGTH = 200;

/** `timestamptz` → imleçteki zaman biçimi (mikrosaniye, UTC). */
export function keysetAtSql(column: SQL): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  return Buffer.from(`${cursor.direction}|${cursor.at}|${cursor.id}`, "utf8").toString("base64url");
}

/** Takvimde gerçekten var olan bir an mı (`2026-02-31` reddedilir). */
function isRealInstant(at: string): boolean {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return false;
  // Milisaniyeye kadar gidiş-dönüş aynı olmalı (taşan gün/saat yok).
  return new Date(ms).toISOString().slice(0, 23) === at.slice(0, 23);
}

export function decodeKeysetCursor(raw: unknown, idKind: KeysetIdKind): KeysetCursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  // Yeniden kodlama aynı olmalı: kanonik olmayan base64 kabul edilmez.
  if (Buffer.from(decoded, "utf8").toString("base64url") !== raw) return null;
  const parts = decoded.split("|");
  if (parts.length !== 3) return null;
  const [direction, at, id] = parts as [string, string, string];
  if (direction !== "a" && direction !== "b") return null;
  if (!AT_PATTERN.test(at) || !isRealInstant(at)) return null;
  if (idKind === "int") {
    if (!INT_PATTERN.test(id) || !Number.isSafeInteger(Number(id))) return null;
  } else if (!UUID_PATTERN.test(id)) {
    return null;
  }
  return { direction, at, id };
}
