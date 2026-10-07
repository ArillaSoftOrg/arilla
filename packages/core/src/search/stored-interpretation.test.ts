import type { Database } from "@arilla/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CLARIFICATION_REGISTRY } from "../clarification/rules.ts";
import { parseStoredInterpretation, readStoredInterpretation } from "./stored-interpretation.ts";

const registry = DEFAULT_CLARIFICATION_REGISTRY;
const Q = "lumbarzyx 2000 tl alti";
const STORED = {
  domainId: "helmet",
  facets: [{ facetId: "helmet_type", optionId: "full_face" }],
  budget: { minKurus: null, maxKurus: 200_000 },
  pricePreference: null,
};

/** Hic dokunulmamasi gereken veritabani: herhangi bir erisim testi patlatir. */
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error("veritabani kullanilmamali");
    },
  },
) as unknown as Database;

/** `select().from().where().limit()` zincirini taklit eden, verilen sonucu ya da hatayi donduren db. */
function stubDb(result: unknown[] | Error): Database {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { select: () => chain } as unknown as Database;
}

afterEach(() => vi.restoreAllMocks());

describe("saklanan yorumun dogrulanmasi", () => {
  it("gecerli yorum aynen doner", () => {
    expect(parseStoredInterpretation(STORED, Q, registry)).toEqual(STORED);
  });

  it.each([
    ["nesne degil", "helmet"],
    ["null", null],
    ["facets dizi degil", { ...STORED, facets: "helmet_type" }],
    ["faset kimligi metin degil", { ...STORED, facets: [{ facetId: 1, optionId: "full_face" }] }],
    ["domain metin degil", { ...STORED, domainId: 42 }],
    ["butce kurus degil", { ...STORED, budget: { minKurus: null, maxKurus: 2000.5 } }],
    ["butce 100'e bolunmuyor", { ...STORED, budget: { minKurus: null, maxKurus: 200_050 } }],
    ["fiyat tercihi bilinmiyor", { ...STORED, pricePreference: "higher" }],
  ])("bicim bozuksa yok sayilir: %s", (_label, stored) => {
    expect(parseStoredInterpretation(stored, Q, registry)).toBeNull();
  });

  it.each([
    ["taksonomide olmayan domain", { ...STORED, domainId: "uydurma" }],
    [
      "taksonomide olmayan secenek",
      { ...STORED, facets: [{ facetId: "helmet_type", optionId: "uydurma" }] },
    ],
    [
      "domain disi faset",
      { ...STORED, domainId: "shoes", facets: [{ facetId: "helmet_type", optionId: "full_face" }] },
    ],
  ])("bugunku taksonomiye uymuyorsa yok sayilir: %s", (_label, stored) => {
    expect(parseStoredInterpretation(stored, Q, registry)).toBeNull();
  });

  it("sorguda yazmayan butce satiri tamamen gecersiz kilar (butce uydurulamaz)", () => {
    expect(
      parseStoredInterpretation(
        { ...STORED, budget: { minKurus: null, maxKurus: 500_000 } },
        Q,
        registry,
      ),
    ).toBeNull();
    // Ayni yorum, butce metinde olmayan baska bir sorgu icin de gecersiz.
    expect(parseStoredInterpretation(STORED, "lumbarzyx", registry)).toBeNull();
  });

  it("bos yorum yok sayilir", () => {
    expect(
      parseStoredInterpretation(
        { domainId: null, facets: [], budget: null, pricePreference: null },
        Q,
        registry,
      ),
    ).toBeNull();
  });
});

describe("okuma", () => {
  it("normalize olmayan, bos ya da uzun sorguda veritabanina hic gidilmez", async () => {
    for (const q of ["", "  Kask  ", "kask  siyah", "a".repeat(201)]) {
      await expect(readStoredInterpretation(untouchable, q)).resolves.toBeNull();
    }
  });

  it("satir yoksa null", async () => {
    await expect(readStoredInterpretation(stubDb([]), Q)).resolves.toBeNull();
  });

  it("kabul edilmis satir dogrulanip doner", async () => {
    await expect(
      readStoredInterpretation(stubDb([{ interpretation: STORED }]), Q),
    ).resolves.toEqual(STORED);
  });

  it("bozuk satir guvenle yok sayilir", async () => {
    await expect(
      readStoredInterpretation(stubDb([{ interpretation: { domainId: "uydurma" } }]), Q),
    ).resolves.toBeNull();
  });

  it("tablo yok (0044 uygulanmamis) ya da sorgu hatasi: null, sorgu metni loglanmaz", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missingTable = Object.assign(
      new Error('relation "query_interpretation" does not exist'),
      {
        code: "42P01",
      },
    );
    await expect(readStoredInterpretation(stubDb(missingTable), Q)).resolves.toBeNull();
    const wrapped = Object.assign(new Error(`Failed query: ... params: ${Q}`), {
      cause: { code: "57014" },
    });
    await expect(readStoredInterpretation(stubDb(wrapped), Q)).resolves.toBeNull();

    expect(warn).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("42P01");
    expect(logged).toContain("57014");
    expect(logged).not.toContain("lumbarzyx");
    expect(logged).not.toContain("does not exist");
  });
});
