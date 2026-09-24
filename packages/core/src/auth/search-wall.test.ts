import { describe, expect, it } from "vitest";
import { imageSearchLimitKey } from "../discovery/image-search-limit.ts";
import { searchWallKey } from "./search-wall.ts";

describe("Redis sayac anahtarlari", () => {
  it("arama duvari anahtari session_id'ye baglidir", () => {
    expect(searchWallKey("abc")).toBe("search-wall:abc");
  });

  it("gorsel arama limiti girisliyse user_id, degilse session_id kullanir", () => {
    expect(imageSearchLimitKey({ userId: 42, sessionId: "abc" })).toBe(
      "image-search-limit:user:42",
    );
    expect(imageSearchLimitKey({ userId: null, sessionId: "abc" })).toBe(
      "image-search-limit:session:abc",
    );
  });
});
