import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_ABSENT_DAYS,
  FRESHNESS_CONFIG_KEY,
  offerVerifiedSql,
  productHasUnverifiedOfferSql,
  visibleWithoutBestOfferSql,
} from "./freshness.ts";

const dialect = new PgDialect();

describe("teklif tazeliği SQL'i (karar 0156)", () => {
  it("politika anahtarları yapılandırmadan okunur, varsayılan en az 2 gün", () => {
    expect(FRESHNESS_CONFIG_KEY).toBe("freshness");
    expect(DEFAULT_MIN_ABSENT_DAYS).toBe(2);
    const { sql: text } = dialect.sqlToQuery(offerVerifiedSql("o"));
    expect(text).toContain("{freshness,unverified_after_days}");
    expect(text).toContain("{freshness,min_absent_days}");
    expect(text).toContain("{freshness,source_stale_after_days}");
  });

  it("bağlama parametresi yok: sorgu planı önbelleğe uygun, kullanıcı girdisi sızmaz", () => {
    for (const fragment of [
      offerVerifiedSql("o"),
      productHasUnverifiedOfferSql("p"),
      visibleWithoutBestOfferSql("p", "bo"),
    ]) {
      expect(dialect.sqlToQuery(fragment).params).toEqual([]);
    }
  });

  it("kaynak sürümü yalnızca tamamlanmış (complete) sürümlerden sayılır", () => {
    const { sql: text } = dialect.sqlToQuery(offerVerifiedSql("o"));
    expect(text).toContain("s.status = 'complete'");
    expect(text).toContain("count(DISTINCT");
  });

  it("geçersiz SQL takma adı reddedilir", () => {
    expect(() => offerVerifiedSql("o; DROP TABLE offer")).toThrow();
    expect(() => productHasUnverifiedOfferSql("p x")).toThrow();
    expect(() => visibleWithoutBestOfferSql("p", "bo)")).toThrow();
  });
});
