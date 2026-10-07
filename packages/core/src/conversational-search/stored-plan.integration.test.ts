/**
 * Karar 0059, `/ara` okuma yolu — gercek yerel Postgres. Saklanan yorum
 * yalnizca okunur: model istemcisi yuklenmez/cagrilmaz, ag istegi yok,
 * `api_usage` / `query_interpretation` / `job_run`'a yazma yok.
 *
 * Yalitim: satirlar bu kosuya ozel sorgu metinleriyle (`sp<sonek> ...`)
 * yazilir ve yalnizca onlar silinir.
 */
import type { Database } from "@arilla/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_CLARIFICATION_REGISTRY } from "../clarification/rules.ts";
import { currentInterpretationIdentity } from "../search/interpretation-identity.ts";
import { readStoredInterpretation } from "../search/stored-interpretation.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { planConversation } from "./plan.ts";
import { planConversationWithStoredInterpretation } from "./stored-plan.ts";

// Okuma yolu saglayici istemcisine dokunursa test patlar.
vi.mock("../llm/gemini.ts", () => {
  const forbidden = () => {
    throw new Error("istek yolunda Gemini istemcisi kullanilmamali");
  };
  return {
    GEMINI_MODEL: "gemini-3.1-flash-lite",
    getLlmClient: forbidden,
    GeminiClient: forbidden,
  };
});

// Okuma yolu is kosusu kaydina dokunursa test patlar.
vi.mock("../ops/job-run.ts", () => {
  const forbidden = () => {
    throw new Error("istek yolunda job_run yazilmamali");
  };
  return { startJobRun: forbidden, finishJobRun: forbidden, withJobRun: forbidden };
});

const S = Date.now().toString(36);
const Q_ACCEPTED = `sp${S} lumbarzyx`;
const Q_BUDGET = `sp${S} lumbarzyx 2000 tl alti`;
const Q_EMPTY = `sp${S} bosyorum`;
const Q_INVALID = `sp${S} gecersizyorum`;
const Q_OLD_HASH = `sp${S} eskiozet`;
const Q_OLD_MODEL = `sp${S} eskimodel`;
const Q_MALFORMED = `sp${S} bozuksatir`;
const Q_MISSING = `sp${S} hicsatiryok`;

const HELMET = {
  domainId: "helmet",
  facets: [{ facetId: "helmet_type", optionId: "full_face" }],
  budget: null,
  pricePreference: null,
};
const IDENTITY = currentInterpretationIdentity(DEFAULT_CLARIFICATION_REGISTRY);
const CONTEXT = { registry: DEFAULT_CLARIFICATION_REGISTRY, lexicon: [] };

/**
 * Yalnizca bu okuma yolunun uretebilecegi satirlar: bu kosunun sorgulari ve
 * GERCEK model surumuyle yazilmis `api_usage` (toplu is testleri sahte model
 * surumu kullanir). Global sayim yok - esanli test dosyalari bu tablolara yazar.
 */
async function scopedCounts() {
  return withOwnerClient(async (c) => {
    const r = await c.query(
      `SELECT (SELECT count(*) FROM api_usage WHERE model_version = $1)::int AS usage,
              (SELECT count(*) FROM query_interpretation WHERE query_norm LIKE $2)::int AS interpretations`,
      [IDENTITY.modelVersion, `sp${S} %`],
    );
    return r.rows[0] as { usage: number; interpretations: number };
  });
}

/** Okuma yolunda yalnizca `select` serbest; her yazma/islem yolu izlenir. */
function writeSpies(db: Database) {
  return (["insert", "update", "delete", "execute", "transaction"] as const).map((method) =>
    vi.spyOn(db, method),
  );
}

describe("saklanan yorum - /ara okuma yolu", () => {
  let db: Database;
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (c) => {
      const insert = (
        q: string,
        status: string,
        interpretation: unknown,
        hash = IDENTITY.taxonomyHash,
        model = IDENTITY.modelVersion,
      ) =>
        c.query(
          `INSERT INTO query_interpretation
             (query_norm, taxonomy_hash, model_version, status, interpretation)
           VALUES ($1, $2, $3, $4, $5)`,
          [q, hash, model, status, interpretation === null ? null : JSON.stringify(interpretation)],
        );
      await insert(Q_ACCEPTED, "accepted", HELMET);
      await insert(Q_BUDGET, "accepted", {
        ...HELMET,
        budget: { minKurus: null, maxKurus: 100_000 },
      });
      await insert(Q_EMPTY, "empty", null);
      await insert(Q_INVALID, "invalid", null);
      await insert(Q_OLD_HASH, "accepted", HELMET, "0".repeat(64));
      await insert(Q_OLD_MODEL, "accepted", HELMET, IDENTITY.taxonomyHash, "gemini-eski-model");
      await insert(Q_MALFORMED, "accepted", { domainId: "uydurma", facets: "yok" });
    });
  });

  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  afterAll(async () => {
    fetchSpy.mockRestore();
    await withOwnerClient((c) =>
      c.query("DELETE FROM query_interpretation WHERE query_norm LIKE $1", [`sp${S} %`]),
    );
  });

  describe("okuma yardimcisi", () => {
    it("bugunku ozet + model + accepted satir doner", async () => {
      await expect(readStoredInterpretation(db, Q_ACCEPTED)).resolves.toEqual(HELMET);
    });

    it.each([
      ["empty", Q_EMPTY],
      ["invalid", Q_INVALID],
      ["eski taksonomi ozeti", Q_OLD_HASH],
      ["eski model surumu", Q_OLD_MODEL],
      ["bozuk satir", Q_MALFORMED],
      ["satir yok", Q_MISSING],
    ])("%s yok sayilir", async (_label, q) => {
      await expect(readStoredInterpretation(db, q)).resolves.toBeNull();
    });

    it("metinde yazmayan saklanan butce satiri gecersiz kilar", async () => {
      // Q_BUDGET metninde 1000 yok: satir dogrulamadan gecmez.
      await expect(readStoredInterpretation(db, Q_BUDGET)).resolves.toBeNull();
    });

    it("bulanik esleme yok: buyuk/kucuk harf ya da bosluk farki eslesmez", async () => {
      await expect(readStoredInterpretation(db, Q_ACCEPTED.toUpperCase())).resolves.toBeNull();
      await expect(readStoredInterpretation(db, `${Q_ACCEPTED} `)).resolves.toBeNull();
      await expect(readStoredInterpretation(db, `${Q_ACCEPTED}x`)).resolves.toBeNull();
    });
  });

  describe("istek yolu", () => {
    it("saklanan yorum domain'i en dusuk oncelikle acar; hicbir yere yazilmaz", async () => {
      const before = await scopedCounts();
      const spies = writeSpies(db);
      const plan = await planConversationWithStoredInterpretation(
        db,
        { query: `  ${Q_ACCEPTED}  `, steps: [] },
        CONTEXT,
      );
      expect(plan.mode).toBe("conversation");
      if (plan.mode === "conversation") {
        expect(plan.constraints.map((chip) => chip.key)).toContain("facet:helmet_type");
      }
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      }
      expect(await scopedCounts()).toEqual(before);
    });

    it("eslesen accepted satir yoksa plan bugunku yolla birebir ayni", async () => {
      for (const q of [Q_MISSING, Q_EMPTY, Q_INVALID, Q_OLD_HASH, Q_OLD_MODEL, Q_MALFORMED]) {
        const withStored = await planConversationWithStoredInterpretation(
          db,
          { query: q, steps: [] },
          CONTEXT,
        );
        expect(withStored).toEqual(planConversation({ query: q, steps: [] }, CONTEXT));
        expect(withStored).toMatchObject({ mode: "conventional", reason: "no_domain" });
      }
    });

    it("deterministik domain bulunursa saklanan yorum okunmaz bile", async () => {
      const select = vi.spyOn(db, "select");
      const plan = await planConversationWithStoredInterpretation(
        db,
        { query: "kask", steps: [] },
        CONTEXT,
      );
      expect(plan).toEqual(planConversation({ query: "kask", steps: [] }, CONTEXT));
      expect(select).not.toHaveBeenCalled();
      select.mockRestore();
    });

    it("okuma hatasi aramayi durdurmaz: plan bugunku yolla ayni", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const select = vi.spyOn(db, "select").mockImplementation(() => {
        throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
      });
      const plan = await planConversationWithStoredInterpretation(
        db,
        { query: Q_ACCEPTED, steps: [] },
        CONTEXT,
      );
      expect(plan).toEqual(planConversation({ query: Q_ACCEPTED, steps: [] }, CONTEXT));
      expect(JSON.stringify(warn.mock.calls)).not.toContain(Q_ACCEPTED);
      select.mockRestore();
      warn.mockRestore();
    });
  });
});
