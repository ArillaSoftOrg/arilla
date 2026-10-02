import { describe, expect, it } from "vitest";
import { decodeKeysetCursor, encodeKeysetCursor } from "./users-cursor.ts";
import {
  decodeUserListCursor,
  encodeUserListCursor,
  parseListDate,
  parseUserListFilters,
  parseUserListSort,
  usedFilterNames,
} from "./users-list.ts";

const AT = "2026-10-03T08:15:42.123456Z";

describe("keyset imleci", () => {
  it("gidiş-dönüş: yön, mikrosaniyeli zaman ve kimlik korunur", () => {
    const raw = encodeKeysetCursor({ direction: "a", at: AT, id: "42" });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeKeysetCursor(raw, "int")).toEqual({ direction: "a", at: AT, id: "42" });
    const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const back = encodeKeysetCursor({ direction: "b", at: AT, id: uuid });
    expect(decodeKeysetCursor(back, "uuid")).toEqual({ direction: "b", at: AT, id: uuid });
  });

  it.each([
    ["boş", ""],
    ["sayı değil", 12],
    ["base64 dışı karakter", "abc=def"],
    ["çok uzun", "a".repeat(201)],
    ["SQL denemesi", Buffer.from(`a|${AT}|1; DROP TABLE app_user`).toString("base64url")],
    ["yön yok", Buffer.from(`x|${AT}|1`).toString("base64url")],
    ["milisaniyeli zaman", Buffer.from("a|2026-10-03T08:15:42.123Z|1").toString("base64url")],
    ["olmayan gün", Buffer.from("a|2026-02-31T08:15:42.123456Z|1").toString("base64url")],
    ["sıfır kimlik", Buffer.from(`a|${AT}|0`).toString("base64url")],
    ["negatif kimlik", Buffer.from(`a|${AT}|-5`).toString("base64url")],
    ["güvenli olmayan büyük kimlik", Buffer.from(`a|${AT}|9999999999999999`).toString("base64url")],
    ["fazla parça", Buffer.from(`a|${AT}|1|2`).toString("base64url")],
  ])("geçersiz imleç reddedilir: %s", (_name, raw) => {
    expect(decodeKeysetCursor(raw, "int")).toBeNull();
  });

  it("uuid beklenen yerde tamsayı, tamsayı beklenen yerde uuid reddedilir", () => {
    expect(
      decodeKeysetCursor(encodeKeysetCursor({ direction: "a", at: AT, id: "7" }), "uuid"),
    ).toBeNull();
    const uuid = encodeKeysetCursor({
      direction: "a",
      at: AT,
      id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    });
    expect(decodeKeysetCursor(uuid, "int")).toBeNull();
  });

  it("liste imleci sıralamaya bağlıdır; başka sıralamanın imleci ilk sayfaya döner", () => {
    const raw = encodeUserListCursor("created", "a", AT, 9);
    expect(decodeUserListCursor(raw, "created")).toEqual({ direction: "a", at: AT, id: "9" });
    expect(decodeUserListCursor(raw, "last_active")).toBeNull();
    expect(decodeUserListCursor("c.bozuk!", "created")).toBeNull();
    expect(decodeUserListCursor(undefined, "created")).toBeNull();
  });
});

describe("liste filtreleri", () => {
  it("allowlist dışındaki değerler düşer, geçerliler kalır", () => {
    expect(
      parseUserListFilters({
        provider: "google",
        role: "superuser",
        earlyAccess: "yes",
        analytics: "maybe",
        createdFrom: "2026-01-01",
        createdTo: "2026-13-01",
        lastActiveFrom: "dün",
        lastActiveTo: "2026-02-28",
        email: "a@b.c",
      }),
    ).toEqual({
      provider: "google",
      earlyAccess: "yes",
      createdFrom: "2026-01-01",
      lastActiveTo: "2026-02-28",
    });
  });

  it("dizi ya da nesne değerler kabul edilmez", () => {
    expect(parseUserListFilters({ provider: ["google"], role: { a: 1 } })).toEqual({});
  });

  it("tarih: biçim, gerçek gün ve aralık", () => {
    expect(parseListDate("2026-02-29")).toBeUndefined();
    expect(parseListDate("2028-02-29")).toBe("2028-02-29");
    expect(parseListDate("1999-12-31")).toBeUndefined();
    expect(parseListDate("2026-1-1")).toBeUndefined();
    expect(parseListDate("2026-01-01T00:00")).toBeUndefined();
  });

  it("sıralama: bilinmeyen değer varsayılana düşer", () => {
    expect(parseUserListSort("last_active")).toBe("last_active");
    expect(parseUserListSort("email")).toBe("created");
    expect(parseUserListSort(undefined)).toBe("created");
  });

  it("denetim için yalnızca filtre adları", () => {
    expect(usedFilterNames({ role: "admin", createdFrom: "2026-01-01" })).toEqual([
      "role",
      "createdFrom",
    ]);
  });
});
