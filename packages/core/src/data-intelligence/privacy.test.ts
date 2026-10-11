import { describe, expect, it } from "vitest";
import { materializeRows } from "./builder.ts";
import { DATASET_SPECS } from "./datasets.ts";
import {
  type BuildForExport,
  csvCell,
  evaluateExportGate,
  parseExportFileName,
  stableStringify,
  toCsv,
} from "./export.ts";
import { CLOSED_POLICY, K_MIN_USERS, policyFromEnv } from "./policy.ts";
import {
  assessAnonymity,
  assessLinkageRisk,
  forbiddenColumnName,
  looksLikePii,
  suppressSmallCells,
  usersBand,
  validateRows,
} from "./privacy.ts";
import { accuracyMetric, wilsonLowerBound } from "./quality.ts";

const cat = DATASET_SPECS.category_trends;
const row = {
  week_start: "2026-09-07",
  category_path: "moda/canta",
  event_type: "product_view",
  events: 50,
  users_band: "10-19",
};

describe("gizlilik", () => {
  it("küçük hücreleri bastırır, bant kesin sayı vermez", () => {
    expect(suppressSmallCells([{ users: 9 }, { users: 10 }]).kept).toHaveLength(1);
    expect(usersBand(9)).toBeNull();
    expect(usersBand(10)).toBe("10-19");
    expect(usersBand(100)).toBe("100+");
  });
  it("kimlik benzeri sütun adı ve değeri reddeder", () => {
    for (const n of [
      "user_id",
      "email",
      "ip_address",
      "query_norm",
      "image_url",
      "session_id",
      "click_id",
    ]) {
      expect(forbiddenColumnName(n)).toBe(true);
    }
    expect(forbiddenColumnName("category_path")).toBe(false);
    expect(looksLikePii("a@b.co")).toBe(true);
    expect(looksLikePii("05321234567")).toBe(true);
    expect(looksLikePii("192.168.1.1")).toBe(true);
    expect(looksLikePii("https://x.com")).toBe(true);
    expect(looksLikePii("moda/canta")).toBe(false);
  });
  it("izinsiz sütun ve serbest metin ihlaldir", () => {
    expect(validateRows(cat, [row])).toEqual([]);
    expect(validateRows(cat, [{ ...row, user_id: 5 }]).length).toBeGreaterThan(0);
    expect(validateRows(cat, [{ ...row, category_path: "Moda Çanta!" }]).length).toBeGreaterThan(0);
    expect(validateRows(cat, [{ ...row, event_type: "search" }]).length).toBeGreaterThan(0);
  });
  it("küçük popülasyon ve eşik altı anonim sayılmaz", () => {
    const a = assessAnonymity({
      spec: cat,
      rows: [row],
      minPublishedUsers: 12,
      populationUsers: 50,
    });
    expect(a.ok).toBe(false);
    expect(a.checks.find((c) => c.id === "min_population")?.passed).toBe(false);
    const b = assessAnonymity({
      spec: cat,
      rows: [row],
      minPublishedUsers: 12,
      populationUsers: 500,
    });
    expect(b.ok).toBe(true);
    const c = assessAnonymity({
      spec: cat,
      rows: [row],
      minPublishedUsers: K_MIN_USERS - 1,
      populationUsers: 500,
    });
    expect(c.ok).toBe(false);
    expect(
      assessAnonymity({ spec: cat, rows: [], minPublishedUsers: null, populationUsers: 500 }).ok,
    ).toBe(false);
  });
  it("birleştirilebilir setlerde eşik yükselir", () => {
    const mk = (key: string, spec: typeof cat, min: number) => ({
      key,
      spec,
      periodStart: "2026-09-07",
      periodEnd: "2026-09-14",
      minPublishedUsers: min,
    });
    const price = DATASET_SPECS.price_range_trends;
    expect(assessLinkageRisk([mk("a", cat, 12), mk("b", price, 12)]).ok).toBe(false);
    expect(assessLinkageRisk([mk("a", cat, 25), mk("b", price, 25)]).ok).toBe(true);
    // ortak niteleyici yok → birleştirilemez
    const brand = DATASET_SPECS.brand_interest_trends;
    expect(assessLinkageRisk([mk("a", cat, 12), mk("b", brand, 12)]).joinablePairs).toEqual([]);
    // dönem çakışmıyor
    expect(
      assessLinkageRisk([
        mk("a", cat, 12),
        { ...mk("b", price, 12), periodStart: "2026-10-05", periodEnd: "2026-10-12" },
      ]).joinablePairs,
    ).toEqual([]);
  });
  it("materializeRows eşik altını atar ve belirleyici sıralar", () => {
    const m = materializeRows(cat, [
      {
        week_start: "2026-09-14",
        dims: { category_path: "moda" },
        event_type: "product_view",
        users: 30,
        events: 40,
      },
      {
        week_start: "2026-09-07",
        dims: { category_path: "moda" },
        event_type: "product_view",
        users: 12,
        events: 20,
      },
      {
        week_start: "2026-09-07",
        dims: { category_path: "ev" },
        event_type: "product_view",
        users: 3,
        events: 9,
      },
    ]);
    expect(m.rows.map((r) => r.week_start)).toEqual(["2026-09-07", "2026-09-14"]);
    expect(m.suppressed).toBe(1);
    expect(m.minUsers).toBe(12);
    expect(JSON.stringify(m.rows)).not.toContain('"users"');
  });
});

describe("dışa aktarım biçimi", () => {
  it("CSV formül enjeksiyonunu etkisizleştirir", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    for (const p of ["+1", "-1", "@a", "\tx", "  =1"])
      expect(csvCell(p).replace(/^"/, "").startsWith("'") || csvCell(p).includes("'")).toBe(true);
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell(5)).toBe("5");
    expect(csvCell(-5)).toBe("");
  });
  it("dosya adı yalnızca sabit listeden", () => {
    expect(parseExportFileName("data.csv")).toBe("data.csv");
    for (const bad of ["../etc/passwd", "..\\x", "data.csv/../../x", "%2e%2e", "", null, 3]) {
      expect(parseExportFileName(bad)).toBeNull();
    }
  });
  it("CSV ve JSON belirleyici", () => {
    expect(toCsv(cat, [row])).toBe(toCsv(cat, [{ ...row }]));
    expect(stableStringify({ b: 1, a: { d: 1, c: 2 } })).toBe(
      stableStringify({ a: { c: 2, d: 1 }, b: 1 }),
    );
  });
});

describe("politika ve kapı", () => {
  it("varsayılan her şey kapalı", () => {
    expect(policyFromEnv({}).buildEnabled).toBe(false);
    expect(policyFromEnv({ DATA_INTELLIGENCE_EXPORT_ENABLED: "true" }).exportEnabled).toBe(false);
    expect(
      policyFromEnv({
        DATA_INTELLIGENCE_BUILD_ENABLED: "true",
        DATA_INTELLIGENCE_EXPORT_ENABLED: "true",
      }).exportEnabled,
    ).toBe(true);
  });
  const build = {
    status: "ready",
    anonymityOk: true,
    datasetKey: "category_trends",
    anonymity: {},
  } as unknown as BuildForExport;
  it("hukuki onay olmadan dışa aktarılmaz", () => {
    const open = policyFromEnv({
      DATA_INTELLIGENCE_BUILD_ENABLED: "true",
      DATA_INTELLIGENCE_EXPORT_ENABLED: "true",
    });
    expect(evaluateExportGate(build, CLOSED_POLICY)?.reason).toBe("export_disabled");
    expect(evaluateExportGate(build, open)?.reason).toBe("legal_not_cleared");
    const cleared = policyFromEnv({
      DATA_INTELLIGENCE_BUILD_ENABLED: "true",
      DATA_INTELLIGENCE_EXPORT_ENABLED: "true",
      DATA_INTELLIGENCE_CLEARED_SOURCES: "user_activity_event",
    });
    expect(evaluateExportGate(build, cleared)).toBeNull();
    expect(evaluateExportGate({ ...build, anonymityOk: false }, cleared)?.reason).toBe(
      "anonymity_not_assured",
    );
    expect(evaluateExportGate({ ...build, status: "blocked" }, cleared)?.reason).toBe(
      "build_not_ready",
    );
  });
});

describe("doğruluk metriği", () => {
  it("yetersiz etiket NOT_MEASURED", () => {
    expect(accuracyMetric({ labeled: 5, correct: 5, incorrect: 0, unsure: 0 }).status).toBe(
      "NOT_MEASURED",
    );
  });
  it("Wilson alt sınırı küçük örneği abartmaz", () => {
    expect(wilsonLowerBound(30, 30)).toBeLessThan(0.95);
    expect(accuracyMetric({ labeled: 400, correct: 396, incorrect: 4, unsure: 0 }).status).toBe(
      "PASS",
    );
    expect(accuracyMetric({ labeled: 100, correct: 70, incorrect: 30, unsure: 0 }).status).toBe(
      "FAIL",
    );
  });
});
