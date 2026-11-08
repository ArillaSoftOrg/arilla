/**
 * Anlamsal arama cevrimdisi degerlendirmesi (karar 0178): insan etiketi icin liste ve puan.
 *
 *   collect  (varsayilan): her sorgu icin metin (bugunku /sohbet katalog yolu), yalniz anlamsal ve
 *            hibrit ("acik olsaydi", gölge olcumle AYNI `fuseForQuery`) ilk 10'u tek etiket
 *            listesinde birlestirir; CSV stdout'a. Katalog okumasi SALT OKUNUR oturumda;
 *            tek yazim sorgu vektoru cagrisinin `api_usage` satiridir (kural 9).
 *   score <dosya.csv>: etiketlenmis CSV'den yontem basina nDCG@10, P@10, ilgisiz@10 (DB/model yok).
 *
 * Uretimde (web konteyneri, `search-probe` ile ayni kalip; DATABASE_URL ve JINA_API_KEY oradan):
 *   docker compose ... exec -T -e EVAL_QUERIES="a|b" web node /app/tools/semantic-eval.mjs > liste.csv
 * Sorgu basina ~18 token (jina-embeddings-v3, `retrieval.query`).
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { apiUsage, createDatabase } from "@arilla/db";
import { sql } from "drizzle-orm";
import { emptyIntent } from "../src/chat/intent.ts";
import { intentToQueryObject, searchByIntent } from "../src/chat/search-adapter.ts";
import { costMicrosPerThousandTokens } from "../src/embedding/embed-uploaded-image.ts";
import { loadLexiconCached } from "../src/search/lexicon-cache.ts";
import { semanticModelVersion } from "../src/search/semantic/config.ts";
import {
  type EvalCsvRow,
  type EvalMethod,
  parseEvalCsv,
  scoreEval,
  toEvalCsv,
} from "../src/search/semantic/eval-score.ts";
import { createJinaQueryEmbedder } from "../src/search/semantic/query-embedder.ts";
import {
  findSemanticCandidates,
  similaritiesFor,
} from "../src/search/semantic/semantic-candidates.ts";
import { fuseForQuery, SEMANTIC_QUERY_OPERATION } from "../src/search/semantic/shadow.ts";

const TOP = 10;

/**
 * `search-probe.ts` ile ayni: her baglanti salt okunur + oturum ust siniri. O dosya ice aktarilmaz
 * (paketlenmis betikte giris denetimi onun `main`'ini de calistirirdi).
 */
function readOnlyUrl(url: string): string {
  const u = new URL(url);
  const extra = "-c default_transaction_read_only=on -c statement_timeout=30000";
  const current = u.searchParams.get("options");
  u.searchParams.delete("options");
  const value = encodeURIComponent(current ? `${current} ${extra}` : extra);
  return `${u.toString()}${u.search ? "&" : "?"}options=${value}`;
}

/** Laptop dikeyi (P1 + laptop kumesi, karar 0177): Turkce ve Ingilizce, cihaz ve aksesuar niyeti. */
export const LAPTOP_QUERIES = [
  "laptop",
  "dizüstü bilgisayar",
  "oyuncu laptopu",
  "oyun bilgisayarı dizüstü",
  "i7 laptop",
  "16 gb ram laptop",
  "ince hafif laptop",
  "öğrenci için laptop",
  "dokunmatik ekranlı laptop",
  "15.6 inç laptop",
  "yenilenmiş laptop",
  "macbook air",
  "macbook pro",
  "lenovo thinkpad",
  "asus rog laptop",
  "hp laptop",
  "dell laptop",
  "msi oyun laptopu",
  "laptop çantası",
  "laptop sırt çantası",
  "laptop soğutucu",
  "laptop standı",
  "laptop şarj aleti",
  "laptop klavyesi",
  "laptop bataryası",
  "macbook kılıf",
  "gaming laptop",
  "ultrabook",
  "chromebook",
  "laptop 16gb ram ssd",
  "laptop bag 15.6",
  "laptop cooling pad",
  "adjustable laptop stand",
  "laptop charger 65w",
  "thinkpad battery",
  "acer nitro",
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function collect(): Promise<number> {
  const url = process.env.DATABASE_URL;
  const apiKey = process.env.JINA_API_KEY?.trim();
  if (!url || !apiKey) {
    console.error("DATABASE_URL ve JINA_API_KEY gerekli");
    return 2;
  }
  process.env.DATABASE_APPLICATION_NAME = "arilla-semantic-eval";
  process.env.DATABASE_POOL_MAX = "1";
  const db = createDatabase(readOnlyUrl(url));
  const ro = await db.execute<{ ro: string }>(
    sql`SELECT current_setting('default_transaction_read_only') AS ro`,
  );
  if (ro.rows[0]?.ro !== "on") {
    console.error("oturum salt okunur DEGIL: degerlendirme baslatilmaz");
    return 2;
  }
  // Yalniz `api_usage` icin ayri, yazilabilir tek baglanti (kural 9).
  const usageDb = createDatabase(url);
  const model = semanticModelVersion();
  let tokens = 0;
  const embedder = createJinaQueryEmbedder(apiKey, model, {
    timeoutMs: 5_000,
    onUsage: async (usage) => {
      tokens += usage.tokens;
      if (usage.cacheHit) return;
      await usageDb.insert(apiUsage).values({
        operation: SEMANTIC_QUERY_OPERATION,
        modelVersion: usage.modelVersion,
        units: usage.tokens,
        costMicros: Math.round((usage.tokens * costMicrosPerThousandTokens()) / 1000),
        cacheHit: false,
      });
    },
  });

  const queries = (process.env.EVAL_QUERIES?.split("|") ?? LAPTOP_QUERIES)
    .map((q) => q.trim())
    .filter((q) => q !== "");
  const lexicon = await loadLexiconCached(db);
  const rows: EvalCsvRow[] = [];
  for (const query of queries) {
    const intent = emptyIntent(query);
    const parsed = intentToQueryObject(intent, lexicon);
    const text = await searchByIntent(db, intent, { pageSize: TOP, lexicon });
    const textItems = text.outcome.items
      .slice(0, TOP)
      .map((i) => ({ productId: i.productId, title: i.title }));
    const remainder = parsed.unparsed.trim();
    const embedded = await embedder.embedQuery(remainder === "" ? parsed.text : remainder);
    if (!embedded) {
      console.error(`sorgu vektoru alinamadi: ${query}`);
      continue;
    }
    const candidates = await findSemanticCandidates(db, {
      vector: embedded.vector,
      modelVersion: model,
      text: parsed.text,
      filters: parsed.filters,
      statementTimeoutMs: 10_000,
    });
    const textSimilarity = await similaritiesFor(db, {
      vector: embedded.vector,
      modelVersion: model,
      productIds: textItems.map((i) => i.productId),
    });
    const { fused } = fuseForQuery(textItems, candidates, parsed.text, textSimilarity);

    const pool = new Map<number, EvalCsvRow>();
    const mark = (method: EvalMethod, id: number, title: string, rank: number) => {
      const row = pool.get(id) ?? {
        query,
        productId: id,
        title,
        ranks: { text: null, semantic: null, hybrid: null },
        similarity: null,
      };
      row.ranks[method] = rank;
      pool.set(id, row);
    };
    for (const [n, i] of textItems.entries()) mark("text", i.productId, i.title, n + 1);
    for (const [n, c] of candidates.slice(0, TOP).entries()) {
      mark("semantic", c.productId, c.title, n + 1);
    }
    for (const [n, e] of fused.slice(0, TOP).entries()) {
      mark("hybrid", e.item.productId, e.item.title, n + 1);
    }
    for (const row of pool.values()) {
      row.similarity =
        candidates.find((c) => c.productId === row.productId)?.similarity ??
        textSimilarity.get(row.productId) ??
        null;
      rows.push(row);
    }
    await sleep(300);
  }
  process.stdout.write(toEvalCsv(rows));
  console.error(`sorgu ${queries.length}, satir ${rows.length}, token ${tokens}`);
  return 0;
}

function score(path: string): number {
  const results = scoreEval(parseEvalCsv(readFileSync(path, "utf8")));
  console.log("yontem    sorgu  nDCG@10  P@10   ilgisiz@10  ort.donen");
  for (const r of results) {
    console.log(
      `${r.method.padEnd(9)} ${String(r.queries).padStart(5)}  ${r.ndcg.toFixed(3)}    ${r.precision.toFixed(3)}  ${r.irrelevant.toFixed(3)}       ${r.returned.toFixed(1)}`,
    );
  }
  return 0;
}

async function main(): Promise<number> {
  const [mode = "collect", file] = process.argv.slice(2);
  if (mode === "score") {
    if (!file) {
      console.error("kullanim: semantic-eval score <etiketli.csv>");
      return 2;
    }
    return score(file);
  }
  if (mode !== "collect") {
    console.error("mod: collect | score <dosya>");
    return 2;
  }
  return collect();
}

const entry = process.argv[1] ?? "";
if (
  import.meta.url === pathToFileURL(entry).href ||
  entry.endsWith("semantic-eval.mjs") ||
  process.env.SEMANTIC_EVAL_MAIN === "1"
) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.name : "hata");
      process.exit(1);
    });
}
