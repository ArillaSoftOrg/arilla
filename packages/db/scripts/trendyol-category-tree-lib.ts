/**
 * Trendyol kategori agacini (karar 0143, `external_category`) aktif ManiCepte `category`
 * agacina entegre eden planin SAF hesabi ve migration/CSV/geri alma ureticisi (karar 0153).
 * Agdan okumaz, veritabanina baglanmaz.
 *
 * Esleme kurali (varsayim YOK, yalniz belirleyici):
 *   - Trendyol dugumu, ayni EBEVEYN baglaminda ayni (Turkce katlanmis) ada sahip TEK bir
 *     MEVCUT dugume eslenir. Kok icin: ayni adli tek mevcut kok. Cocuk icin: ebeveyni bir
 *     mevcut dugume eslenmis olmali ve o dugumun cocugu arasinda ayni adli tek dugum olmali.
 *   - Ayni adli ama FARKLI ebeveynli dugumler karistirilmaz (ayri kategori olusturulur).
 *   - Ayni ebeveynde ayni ada sahip birden fazla Trendyol kardesi ya da birden fazla mevcut
 *     aday varsa ESLESME YAPILMAZ (belirsiz); hepsi ayri olusturulur.
 *   - Anlamca benzer ama ad/ebeveyn farkli olanlar (ornegin "Ağız Bakım" - "Ağız ve Diş
 *     Bakımı") otomatik eslenmez; ayri kategori olarak kalir.
 * Olusturulan her dugum Trendyol'un hiyerarsisini aynen tasir; yeni dugumler
 * `is_discoverable = FALSE` ile acilir (bos ve siniflandiricisiz; kesfet/site haritasina
 * girmez; urun baglanip politika gozden gecirilince acilir).
 */
import type { TrendyolNode } from "./trendyol-categories-lib.ts";
import { SOURCE } from "./trendyol-categories-lib.ts";

export interface BaselineCategory {
  path: string;
  slug: string;
  name: string;
}

export interface PlanRow {
  externalId: number;
  parentExternalId: number | null;
  depth: number;
  /** "match": mevcut dugumla eslesti; "create": yeni dugum. */
  action: "match" | "create";
  /** ManiCepte `category.path` (eslesende mevcut yol, olusturulanda yeni yol). */
  path: string;
  slug: string;
  /** Trendyol adi. */
  name: string;
  /** Yalniz `match`: mevcut dugumun AYNEN adi (migration bunu dogrular). */
  matchedName: string | null;
  trendyolPath: string;
}

export interface PlanSummary {
  total: number;
  matched: number;
  created: number;
  roots: number;
  newRoots: number;
  maxDepth: number;
  perDepth: Record<string, number>;
  slugSuffixed: number;
  pathSuffixed: number;
}

/**
 * Tohum betiginin (packages/db/scripts/seed.ts) kullandigi, migration yollarindan farkli
 * slug'lar. Tohum `ON CONFLICT (slug) DO UPDATE` ile calistigindan, bu slug'lardan biri
 * Trendyol'dan olusturulan bir dugume verilirse tohum onu EZERDI. Bu yuzden olusturulan
 * dugumler bu slug'lari kullanmaz (testle seed.ts'ten dogrulanir).
 */
export const RESERVED_SEED_SLUGS: readonly string[] = [
  "moda",
  "ayakkabi",
  "canta",
  "ust-giyim",
  "elbise",
  "dis-giyim",
  "saglik-kozmetik",
  "kozmetik",
  "parfum",
  "cilt-bakimi",
  "ic-giyim",
  "elektronik",
  "petshop",
  "supermarket",
];

const TR_MAP: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  ö: "o",
  ş: "s",
  ü: "u",
  â: "a",
  î: "i",
  û: "u",
};

/** Turkce katlama: buyuk/kucuk, aksan, noktalama ve "&" farki ortadan kalkar. */
export function fold(value: string): string {
  const lower = value.replace(/İ/g, "i").replace(/I/g, "ı").toLowerCase();
  const mapped = [...lower].map((ch) => TR_MAP[ch] ?? ch).join("");
  return mapped
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function slugify(value: string): string {
  return fold(value).replace(/ /g, "-");
}

/** Dugumun slug'i: yolun '-' ile birlesimi (0089'dan beri gecerli kural). */
export const pathToSlug = (path: string): string => path.replace(/\//g, "-");

const parentPathOf = (path: string): string | null =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;

/**
 * Plani hesaplar. `nodes`: `parseTrendyolTree` ciktisi (derinlik oncelikli). `baseline`:
 * entegrasyon oncesi ManiCepte agaci. Cikti kaynak sirasindan bagimsiz, deterministiktir.
 */
export function planTree(
  nodes: readonly TrendyolNode[],
  baseline: readonly BaselineCategory[],
  reservedSlugs: readonly string[] = RESERVED_SEED_SLUGS,
): { rows: PlanRow[]; summary: PlanSummary } {
  const byParent = new Map<number | null, TrendyolNode[]>();
  for (const node of nodes) {
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }
  const baselineChildren = new Map<string | null, BaselineCategory[]>();
  for (const category of baseline) {
    const key = parentPathOf(category.path);
    const list = baselineChildren.get(key) ?? [];
    list.push(category);
    baselineChildren.set(key, list);
  }
  const usedPaths = new Set(baseline.map((c) => c.path));
  const usedSlugs = new Set([...baseline.map((c) => c.slug), ...reservedSlugs]);
  const rows: PlanRow[] = [];
  let slugSuffixed = 0;
  let pathSuffixed = 0;

  const visit = (parentId: number | null, parentPath: string | null, parentMatched: boolean) => {
    const siblings = byParent.get(parentId) ?? [];
    const candidates = parentMatched ? (baselineChildren.get(parentPath) ?? []) : [];
    const sameName = new Map<string, number>();
    for (const sibling of siblings) {
      const key = fold(sibling.name);
      sameName.set(key, (sameName.get(key) ?? 0) + 1);
    }
    for (const sibling of siblings) {
      const key = fold(sibling.name);
      const hits = candidates.filter((candidate) => fold(candidate.name) === key);
      const hit = hits.length === 1 && sameName.get(key) === 1 ? hits[0] : undefined;
      let row: PlanRow;
      if (hit) {
        row = {
          externalId: sibling.id,
          parentExternalId: parentId,
          depth: sibling.depth,
          action: "match",
          path: hit.path,
          slug: hit.slug,
          name: sibling.name,
          matchedName: hit.name,
          trendyolPath: sibling.pathText,
        };
      } else {
        const segment = slugify(sibling.name) || `k${sibling.id}`;
        let path = parentPath === null ? segment : `${parentPath}/${segment}`;
        if (usedPaths.has(path)) {
          path = `${path}-ty${sibling.id}`;
          pathSuffixed += 1;
        }
        usedPaths.add(path);
        let slug = pathToSlug(path);
        if (usedSlugs.has(slug)) {
          slug = `${slug}-ty${sibling.id}`;
          slugSuffixed += 1;
        }
        usedSlugs.add(slug);
        row = {
          externalId: sibling.id,
          parentExternalId: parentId,
          depth: sibling.depth,
          action: "create",
          path,
          slug,
          name: sibling.name,
          matchedName: null,
          trendyolPath: sibling.pathText,
        };
      }
      rows.push(row);
      visit(sibling.id, row.path, row.action === "match");
    }
  };
  visit(null, null, true);

  const perDepth: Record<string, number> = {};
  let maxDepth = 0;
  for (const row of rows) {
    const pathDepth = row.path.split("/").length;
    perDepth[String(pathDepth)] = (perDepth[String(pathDepth)] ?? 0) + 1;
    maxDepth = Math.max(maxDepth, pathDepth);
  }
  const summary: PlanSummary = {
    total: rows.length,
    matched: rows.filter((row) => row.action === "match").length,
    created: rows.filter((row) => row.action === "create").length,
    roots: rows.filter((row) => row.parentExternalId === null).length,
    newRoots: rows.filter((row) => row.parentExternalId === null && row.action === "create").length,
    maxDepth,
    perDepth,
    slugSuffixed,
    pathSuffixed,
  };
  return { rows: sortRows(rows), summary };
}

/** Isleme sirasi: derinlik, sonra Trendyol kimligi (ebeveyn her zaman cocuktan once). */
function sortRows(rows: PlanRow[]): PlanRow[] {
  return [...rows].sort((a, b) => a.depth - b.depth || a.externalId - b.externalId);
}

/** `path\tslug\tname\tdiscoverable` TSV'sini okur (ilk satir baslik). */
export function parseBaseline(tsv: string): BaselineCategory[] {
  const lines = tsv.split("\n").filter((line) => line.trim() !== "");
  const header = lines.shift();
  if (header !== "path\tslug\tname\tdiscoverable") throw new Error("taban TSV basligi beklenmedik");
  return lines.map((line) => {
    const [path, slug, name] = line.split("\t");
    if (!path || !slug || !name) throw new Error(`taban TSV satiri bozuk: ${line}`);
    return { path, slug, name };
  });
}

const sqlText = (value: string): string => `'${value.replace(/'/g, "''")}'`;

export const MIGRATION_NUMBER = "0102";
export const DECIDED_BY = `migration:${MIGRATION_NUMBER}`;

/** Gecis migration'i: idempotent, yalnizca ekleme, guvenlik kontrollu. */
export function renderMigration(
  sha256: string,
  rows: readonly PlanRow[],
  summary: PlanSummary,
): string {
  const values = rows
    .map(
      (row) =>
        `            (${row.externalId}, ${row.depth}, ${sqlText(row.path)}, ${sqlText(row.slug)}, ${
          row.matchedName === null ? "NULL" : sqlText(row.matchedName)
        })`,
    )
    .join(",\n");
  return `-- kind: data
-- ${MIGRATION_NUMBER} — Trendyol kategori agacinin aktif ManiCepte agacina entegrasyonu (karar 0153)
--
-- Kaynak: \`external_category\` (source = 'trendyol'; 0096/0097, ham dosya sha256 ${sha256}).
-- Toplam ${summary.total} Trendyol kategorisi: ${summary.matched} mevcut dugumle ESLESTI (ayni ebeveyn
-- baglaminda ayni ad), ${summary.created} yeni dugum OLUSTURULDU (${summary.newRoots} yeni ana kategori).
-- Mevcut 158 dugum: kimlik, slug, ad, yol, ebeveyn ve urun iliskileri DEGISMEZ.
--
-- YALNIZCA EKLEME ve IDEMPOTENT: \`external_category_map\` satiri olan Trendyol kategorisi atlanir.
-- Guvenlik (lint kurali data-raise: veri migration'i dagitimi dusurmez): beklenmedik durumda
-- (mevcut dugum yok/adi farkli, yol zaten var, ebeveyn eslesmesi yok) o dugumu UYDURMADAN ATLAR
-- ve NOTICE ile raporlar; atlanan dugumun altindakiler de atlanir. Bir sonraki kosu (idempotent)
-- kalani isler; atlanan Trendyol kategorileri \`external_category_map\`te eslesmesiz kalir.
-- Yeni dugumler \`is_discoverable = FALSE\` ile acilir: bos ve siniflandiricisizdir (karar 0153 §5).
-- Siniflandirici (services/ingest/classify) bu dugumlere yalnizca kural yoluyla ulasir; kural
-- eklenmedigi surece hicbir urun buraya yazilmaz.
-- Geri alma: docs/reference/trendyol/category-tree-rollback.sql (karar 0153 §8).

DO $$
DECLARE
    node RECORD;
    parent_cat BIGINT;
    parent_path TEXT;
    cat_id BIGINT;
    cand_slug TEXT;
    ext_total INTEGER;
    n_match INTEGER := 0;
    n_create INTEGER := 0;
    n_skip INTEGER := 0;
    n_bad INTEGER := 0;
BEGIN
    SELECT count(*) INTO ext_total FROM external_category WHERE source = '${SOURCE}';
    IF ext_total <> ${summary.total} THEN
        RAISE NOTICE '${MIGRATION_NUMBER}: external_category(${SOURCE}) % satir, beklenen ${summary.total} (0097 uygulanmamis?); HICBIR SEY YAZILMADI', ext_total;
        RETURN;
    END IF;

    FOR node IN
        SELECT t.ext_id, t.depth, t.path, t.slug, t.match_name, ec.name, ec.parent_external_id
          FROM (VALUES
${values}
          ) AS t(ext_id, depth, path, slug, match_name)
          JOIN external_category ec ON ec.source = '${SOURCE}' AND ec.external_id = t.ext_id
         ORDER BY t.depth, t.ext_id
    LOOP
        IF EXISTS (SELECT 1 FROM external_category_map
                    WHERE source = '${SOURCE}' AND external_id = node.ext_id) THEN
            n_skip := n_skip + 1;
            CONTINUE;
        END IF;

        IF node.match_name IS NOT NULL THEN
            SELECT id INTO cat_id FROM category
             WHERE path = node.path AND name = node.match_name ORDER BY id LIMIT 1;
            IF cat_id IS NULL THEN
                RAISE NOTICE '${MIGRATION_NUMBER}: atlandi, eslesecek mevcut dugum yok ya da adi farkli: % (%)',
                    node.path, node.match_name;
                n_bad := n_bad + 1;
                CONTINUE;
            END IF;
            INSERT INTO external_category_map
                (source, external_id, category_id, status, decided_by, note)
            VALUES ('${SOURCE}', node.ext_id, cat_id, 'confirmed', '${DECIDED_BY}', 'exact_name');
            n_match := n_match + 1;
        ELSE
            parent_cat := NULL;
            IF node.parent_external_id IS NOT NULL THEN
                SELECT m.category_id, c.path INTO parent_cat, parent_path
                  FROM external_category_map m JOIN category c ON c.id = m.category_id
                 WHERE m.source = '${SOURCE}' AND m.external_id = node.parent_external_id;
                IF parent_cat IS NULL THEN
                    RAISE NOTICE '${MIGRATION_NUMBER}: atlandi, ebeveyn eslesmesi yok: % (ebeveyn %)',
                        node.ext_id, node.parent_external_id;
                    n_bad := n_bad + 1;
                    CONTINUE;
                END IF;
                IF regexp_replace(node.path, '/[^/]+$', '') <> parent_path THEN
                    RAISE NOTICE '${MIGRATION_NUMBER}: atlandi, yol ebeveynle tutarsiz: % (ebeveyn yolu %)',
                        node.path, parent_path;
                    n_bad := n_bad + 1;
                    CONTINUE;
                END IF;
            ELSIF position('/' IN node.path) > 0 THEN
                RAISE NOTICE '${MIGRATION_NUMBER}: atlandi, kok dugum yolu bilesik: %', node.path;
                n_bad := n_bad + 1;
                CONTINUE;
            END IF;
            IF EXISTS (SELECT 1 FROM category WHERE path = node.path) THEN
                RAISE NOTICE '${MIGRATION_NUMBER}: atlandi, yol zaten var (uydurma eslesme yapilmaz): %', node.path;
                n_bad := n_bad + 1;
                CONTINUE;
            END IF;
            cand_slug := node.slug;
            IF EXISTS (SELECT 1 FROM category WHERE slug = cand_slug) THEN
                cand_slug := cand_slug || '-ty' || node.ext_id;
            END IF;
            INSERT INTO category (slug, name, parent_id, path, is_discoverable)
            VALUES (cand_slug, node.name, parent_cat, node.path, FALSE)
            RETURNING id INTO cat_id;
            INSERT INTO external_category_map
                (source, external_id, category_id, status, decided_by, note)
            VALUES ('${SOURCE}', node.ext_id, cat_id, 'confirmed', '${DECIDED_BY}', 'created');
            n_create := n_create + 1;
        END IF;
    END LOOP;

    RAISE NOTICE '${MIGRATION_NUMBER}: % eslesti, % olusturuldu, % zaten islenmisti, % UYDURULMADAN atlandi',
        n_match, n_create, n_skip, n_bad;
END $$;
`;
}

const csvCell = (value: string | number | null): string => {
  const text = value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** Kalici esleme tablosu (Trendyol kimligi -> ManiCepte yolu/slug'i), inceleme icin. */
export function renderCsv(rows: readonly PlanRow[]): string {
  const header = [
    "trendyol_id",
    "trendyol_parent_id",
    "trendyol_depth",
    "trendyol_path",
    "action",
    "manicepte_path",
    "manicepte_slug",
    "manicepte_name",
    "matched_existing_name",
    "is_discoverable",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.externalId,
        row.parentExternalId,
        row.depth,
        row.trendyolPath,
        row.action,
        row.path,
        row.slug,
        row.name,
        row.matchedName,
        row.action === "create" ? "false" : "unchanged",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Geri alma betigi (elle, onayla). Yalnizca bu migration'in OLUSTURDUGU dugumleri siler. */
export function renderRollback(summary: PlanSummary): string {
  return `-- Geri alma: ${MIGRATION_NUMBER} (karar 0153 §8). ELLE ve ONAYLA calistirilir; migration degildir.
--
-- Yalnizca bu migration'in OLUSTURDUGU (${summary.created}) kategoriyi ve butun Trendyol eslemesini
-- (${summary.total}) siler. Mevcut 158 dugume DOKUNMAZ. Bir urun, siniflandirma, kaynak eslemesi
-- ya da baska bir tablo olusturulan bir dugume baglanmissa yabanci anahtar HATA verir ve TUM islem
-- geri alinir (kismi silme olmaz): once o baglantilar kaldirilmalidir.
BEGIN;

CREATE TEMP TABLE _tree_created ON COMMIT DROP AS
SELECT category_id FROM external_category_map
 WHERE source = '${SOURCE}' AND decided_by = '${DECIDED_BY}' AND note = 'created';

DELETE FROM external_category_map
 WHERE source = '${SOURCE}' AND decided_by = '${DECIDED_BY}';

-- Tek ifade: ebeveyn ve cocuklar birlikte silinir (yabanci anahtar ifade sonunda denetlenir).
DELETE FROM category WHERE id IN (SELECT category_id FROM _tree_created);

COMMIT;
`;
}
