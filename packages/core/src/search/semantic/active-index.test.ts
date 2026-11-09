import { readFileSync } from "node:fs";
import type { Database } from "@arilla/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_INDEX_TTL_MS,
  DEFAULT_SEMANTIC_INDEX,
  indexForRow,
  QUERYABLE_INDEXES,
  resetActiveIndexCache,
  resolveSemanticIndex,
} from "./active-index.ts";
import { DEFAULT_SEMANTIC_MODEL } from "./config.ts";

const db = {} as Database;
const V3_ROW = {
  model_version: "jina-embeddings-v3",
  storage_table: "product_text_embedding",
  dimensions: 768,
};

interface RegistryModel {
  id: string;
  provider: string;
  roles: string[];
  dimensions: number;
  tasks: Record<string, string>;
  index_family: string;
  state: string;
}

interface RegistryFile {
  index_families: Record<string, { table: string | null; dimensions: number }>;
  defaults: Record<string, string>;
  models: RegistryModel[];
}

function pythonRegistry(): RegistryFile {
  const url = new URL("../../../../../services/ingest/enrich/model_registry.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as RegistryFile;
}

beforeEach(() => resetActiveIndexCache());

describe("kayit defteri paritesi (Python model_registry.json)", () => {
  const registry = pythonRegistry();

  it("TS'nin sorgulayabildigi her model kayit defterinde ayni boyut, gorev ve tabloyla var", () => {
    for (const index of Object.values(QUERYABLE_INDEXES)) {
      const model = registry.models.find((m) => m.id === index.modelVersion);
      expect(model, index.modelVersion).toBeDefined();
      if (!model) continue;
      expect(model.provider).toBe("jina");
      expect(model.roles).toContain("product_text");
      expect(model.dimensions).toBe(index.dimensions);
      expect(model.tasks.query).toBe(index.queryTask);
      expect(registry.index_families[model.index_family]?.table).toBe(index.table);
      expect(registry.index_families[model.index_family]?.dimensions).toBe(index.dimensions);
    }
  });

  it("varsayilan model iki tarafta ayni", () => {
    expect(registry.defaults.product_text).toBe(DEFAULT_SEMANTIC_MODEL);
    expect(DEFAULT_SEMANTIC_INDEX.modelVersion).toBe(DEFAULT_SEMANTIC_MODEL);
  });

  it("TS beyaz listesindeki tablolar migration 0110'un izin verdigi tablolar", () => {
    const tables = new Set(
      Object.values(registry.index_families)
        .map((family) => family.table)
        .filter(
          (table): table is string => typeof table === "string" && table.startsWith("product_text"),
        ),
    );
    for (const index of Object.values(QUERYABLE_INDEXES)) expect(tables).toContain(index.table);
  });
});

describe("aktif indeks cozumleme", () => {
  it("veritabanindaki active satiri kullanir", async () => {
    const result = await resolveSemanticIndex(db, { env: {}, readActive: async () => V3_ROW });
    expect(result).toEqual({ index: DEFAULT_SEMANTIC_INDEX, source: "db" });
  });

  it("TS'nin sorgu vektoru uretemedigi model -> null (karistirma yok)", async () => {
    const row = {
      model_version: "e5-small-int8-0bcc8ca76950",
      storage_table: "product_text_embedding_d384",
      dimensions: 384,
    };
    expect(await resolveSemanticIndex(db, { env: {}, readActive: async () => row })).toEqual({
      index: null,
      reason: "unsupported_model",
      modelVersion: "e5-small-int8-0bcc8ca76950",
    });
  });

  it("satir beyaz listeyle birebir ortusmezse (tablo/boyut) kabul edilmez", () => {
    expect(indexForRow({ ...V3_ROW, storage_table: "product_text_embedding_d384" })).toBeNull();
    expect(indexForRow({ ...V3_ROW, dimensions: 384 })).toBeNull();
    expect(indexForRow(V3_ROW)).toBe(DEFAULT_SEMANTIC_INDEX);
  });

  it("aktif indeks yoksa olcum yapilmaz", async () => {
    expect(await resolveSemanticIndex(db, { env: {}, readActive: async () => null })).toEqual({
      index: null,
      reason: "no_active_index",
      modelVersion: DEFAULT_SEMANTIC_MODEL,
    });
  });

  it("tablo okunamazsa (migration oncesi) varsayilana duser, firlatmaz", async () => {
    const readActive = async () => {
      throw new Error('relation "embedding_index" does not exist');
    };
    expect(await resolveSemanticIndex(db, { env: {}, readActive })).toEqual({
      index: DEFAULT_SEMANTIC_INDEX,
      source: "fallback",
    });
  });

  it("acik ortam ayari onceliklidir; listede olmayan ad varsayilan tabloda aranir (0178)", async () => {
    const readActive = vi.fn(async () => V3_ROW);
    expect(
      await resolveSemanticIndex(db, {
        env: { SEMANTIC_EMBEDDING_MODEL: "jina-embeddings-v3" },
        readActive,
      }),
    ).toEqual({ index: DEFAULT_SEMANTIC_INDEX, source: "env" });
    expect(
      await resolveSemanticIndex(db, {
        env: { SEMANTIC_EMBEDDING_MODEL: "jina-embeddings-v4" },
        readActive,
      }),
    ).toEqual({
      index: { ...DEFAULT_SEMANTIC_INDEX, modelVersion: "jina-embeddings-v4" },
      source: "env",
    });
    expect(readActive).not.toHaveBeenCalled();
  });

  it("aktif satir TTL boyunca onbellekten okunur, sonra yenilenir", async () => {
    let now = 1_000;
    const readActive = vi.fn(async () => V3_ROW);
    const deps = { env: {}, readActive, now: () => now };
    await resolveSemanticIndex(db, deps);
    await resolveSemanticIndex(db, deps);
    expect(readActive).toHaveBeenCalledTimes(1);
    now += ACTIVE_INDEX_TTL_MS;
    await resolveSemanticIndex(db, deps);
    expect(readActive).toHaveBeenCalledTimes(2);
  });
});
