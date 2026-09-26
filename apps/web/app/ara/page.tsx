import {
  type ConversationPlan,
  isRedisUnavailableError,
  loadLexicon,
  planConversation,
  type QueryObject,
  recordSearchAndCheckWall,
  resolveQuery,
  type SortMode,
  search,
} from "@arilla/core";
import { DEFAULT_CLARIFICATION_REGISTRY } from "@arilla/core/clarification";
import { type Database, getDatabase } from "@arilla/db";
import {
  ClarificationBar,
  ClarificationQuestion,
  EmptyState,
  SearchConversationInput,
  SearchForm,
  SearchIntentChips,
  SortTabs,
} from "@arilla/ui";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifySession } from "../lib/dal.ts";
import { PhotoSearchButton } from "../photo-search-client.tsx";
import styles from "./ara.module.css";
import { ResultGrid, resultCountLabel } from "./search-results.tsx";
import { SearchWallGateClient } from "./search-wall-gate-client.tsx";

const SORT_MODES: readonly SortMode[] = ["balanced", "best_deal", "closest_match"];

function isSortMode(value: string | undefined): value is SortMode {
  return SORT_MODES.includes(value as SortMode);
}

const SEARCH_PLACEHOLDER = "Ürün adı, marka ya da kısa bir tarif yaz";
const PAGE_SIZE = 24;

/** Arama kutusu + fotoğraf eylemi; tüm /ara durumlarında aynı yerde. */
function SearchToolbar({ query }: { query?: string }) {
  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarSearch}>
        <SearchForm defaultValue={query} placeholder={SEARCH_PLACEHOLDER} submitLabel="Ara" />
      </div>
      <PhotoSearchButton />
    </div>
  );
}

interface AramaSearchParams {
  q?: string;
  sort?: string;
  sayfa?: string;
  /** Konusma adimlari (docs/decisions/0030, `CONVERSATION_PARAM`). */
  n?: string | string[];
  /** Soru ya da daraltma kutusundan gelen serbest yanit; kanonik URL'e yonlendirilir. */
  yanit?: string;
}

function toList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Konusma adimlarini koruyan /ara linki. Sayfa 1 ve "balanced" varsayilandir, yazilmaz. */
function aramaHref({
  query,
  steps,
  sort,
  page,
}: {
  query: string;
  steps: readonly string[];
  sort?: SortMode;
  page?: number;
}): string {
  const params = new URLSearchParams({ q: query });
  for (const step of steps) params.append("n", step);
  if (sort && sort !== "balanced") params.set("sort", sort);
  if (page && page > 1) params.set("sayfa", String(page));
  return `/ara?${params.toString()}`;
}

/**
 * Netlestirme katmani calismazsa (sozluk okunamadi, beklenmeyen hata) arama
 * calismaya devam eder: kullanicinin sorgusu mevcut yoldan aranir.
 */
async function planSafely(
  db: Database,
  request: { query: string; steps: readonly string[]; reply: string | null },
): Promise<ConversationPlan> {
  try {
    const lexicon = await loadLexicon(db);
    return planConversation(request, { registry: DEFAULT_CLARIFICATION_REGISTRY, lexicon });
  } catch (error) {
    console.error("[ara] clarification unavailable, falling back to plain search", error);
    return { mode: "conventional", query: request.query, reason: "no_domain" };
  }
}

/**
 * docs/pages.md "/ara": arama girdisi -> netleştirme çubuğu (varsa) ->
 * sonuç sayısı -> sekmeler -> sonuç ızgarası -> sayfalama. Giriş modali
 * (decision 0002, E2) burada; görsel arama sonucu ayrı bir rotada
 * (`/ara/gorsel`), yükleme girdisi burada (D4).
 */
export default async function AramaPage({
  searchParams,
}: {
  searchParams: Promise<AramaSearchParams>;
}) {
  const { q, sort: sortParam, sayfa, n, yanit } = await searchParams;
  const requestedQuery = q?.trim() ?? "";
  const requestedSteps = toList(n);
  const reply = yanit?.trim() || null;

  if (!requestedQuery) {
    return (
      <div className={styles.page}>
        <header className={styles.header}>
          <h1 className={styles.title}>Ne arıyorsun?</h1>
          <p className={styles.lede}>Aramak için aşağıya bir şey yaz ya da fotoğraf yükle.</p>
        </header>
        <SearchToolbar />
      </div>
    );
  }

  const db = getDatabase();
  const plan = await planSafely(db, { query: requestedQuery, steps: requestedSteps, reply });
  const query = plan.query;
  const steps = plan.mode === "conversation" ? plan.steps : [];
  const requestedSort = isSortMode(sortParam) ? sortParam : "balanced";

  // Serbest yanit ve bayat adimlar kanonik URL'e cevrilir: geri tusu ve
  // paylasilan link ayni konusmayi kurar, `yanit` URL'de kalmaz.
  if (
    reply !== null ||
    query !== requestedQuery ||
    (plan.mode === "conversation" && plan.droppedInvalidStep) ||
    (plan.mode === "conventional" && requestedSteps.length > 0)
  ) {
    redirect(aramaHref({ query, steps, sort: requestedSort }));
  }

  // decision 0002: ilk N sorgu serbest, sonrasında modal. Girişi olanlar için
  // hiç sayılmaz; session_id proxy.ts tarafından garanti edilir ama bu istek
  // proxy'nin ilk kez yazdığı çerezi henüz görmüyor olabilir (Next: Server
  // Component render sırasında çerez okunur, o istekte YAZILAMAZ).
  // Bir sorunun cevabi ya da daraltma yeni bir arama degildir; duvar
  // sayacina yalnizca konusmanin ilk istegi yazilir.
  let shouldShowWall = false;
  const user = await verifySession();
  if (!user && steps.length === 0) {
    const sessionId = (await cookies()).get("session_id")?.value;
    if (sessionId) {
      // Arama duvari yalnizca surtunme (karar 0002): Redis erisilemezse arama
      // calismaya devam eder, duvar bu istekte atlanir ve durum loglanir.
      try {
        shouldShowWall = (await recordSearchAndCheckWall(sessionId)).shouldShowWall;
      } catch (error) {
        if (!isRedisUnavailableError(error)) throw error;
        console.error("[ara] search wall skipped: redis unavailable");
      }
    }
  }

  let parsed: QueryObject;
  let needsClarification = false;
  let candidateCategories: Awaited<ReturnType<typeof resolveQuery>>["candidateCategories"] = null;
  if (plan.mode === "conversation") {
    parsed = plan.queryObject;
  } else {
    ({ parsed, needsClarification, candidateCategories } = await resolveQuery(db, query));
  }

  const hasAnchor = parsed.anchor !== null;
  // C1'in metin ayristiricisi her zaman anchor: null uretir (kapsami disinda);
  // C2'nin search()'u closest_match'i anchor'siz kabul etmez. Metin
  // aramasinda bu sekme bu yuzden her zaman devre disi.
  const effectiveSort: SortMode =
    requestedSort === "closest_match" && !hasAnchor ? "balanced" : requestedSort;

  const page = Math.max(1, Number.parseInt(sayfa ?? "1", 10) || 1);
  const result = await search(
    db,
    { ...parsed, sort: effectiveSort },
    { limit: 24, offset: (page - 1) * 24 },
  );

  let items = result.items;
  let isFallback = false;
  if (items.length === 0) {
    // docs/pages.md: "Boş sonuç: filtreleri gevşetme önerisi + en yakın 6
    // sonuç." Gevşetme icin kesin algoritma belirtilmemis; en basit ve
    // savunulabilir yorum: tum filtreleri temizle.
    const fallback = await search(db, { ...parsed, filters: {}, sort: "balanced" }, { limit: 6 });
    items = fallback.items;
    isFallback = true;
  }

  function sortHref(target: SortMode): string {
    return aramaHref({ query, steps, sort: target });
  }

  const tabs = [
    {
      value: "balanced",
      label: "Bizim seçtiklerimiz",
      href: sortHref("balanced"),
      active: effectiveSort === "balanced",
    },
    {
      value: "best_deal",
      label: "En iyi fırsatlar",
      href: sortHref("best_deal"),
      active: effectiveSort === "best_deal",
    },
    {
      value: "closest_match",
      label: "En yakın eşleşmeler",
      href: sortHref("closest_match"),
      active: effectiveSort === "closest_match",
      disabled: !hasAnchor,
      disabledHint: "Bu arama için kullanılamıyor",
    },
  ];

  const totalPages = Math.ceil(result.total / PAGE_SIZE);

  function pageHref(target: number): string {
    return aramaHref({ query, steps, sort: effectiveSort, page: target });
  }

  function stepsHref(nextSteps: readonly string[]): string {
    return aramaHref({ query, steps: nextSteps, sort: effectiveSort });
  }

  const conversationFields = [
    { name: "q", value: query },
    ...steps.map((value) => ({ name: "n", value })),
    ...(effectiveSort !== "balanced" ? [{ name: "sort", value: effectiveSort }] : []),
  ];

  return (
    <div className={styles.page}>
      <SearchWallGateClient show={shouldShowWall} />
      <SearchToolbar query={query} />

      <header className={styles.header}>
        <h1 className={styles.title}>“{query}” için sonuçlar</h1>
        {!isFallback ? (
          <p className={styles.count} role="status">
            {resultCountLabel(result.total)}
          </p>
        ) : null}
      </header>

      <div className={styles.controls}>
        {plan.mode === "conversation" && plan.question ? (
          <ClarificationQuestion
            headingId="netlestirme-sorusu"
            question={plan.question.text}
            options={plan.question.options.map((option) => ({
              id: option.id,
              label: option.label,
              selected: option.selected,
              href: stepsHref(option.steps),
            }))}
            skip={{ label: plan.question.skip.label, href: stepsHref(plan.question.skip.steps) }}
            showResults={{
              label: plan.question.showResults.label,
              href: stepsHref(plan.question.showResults.steps),
            }}
            freeText={{
              label: "Ya da kendi cümlenle yaz",
              placeholder: "Aklındakini kısaca anlat",
              action: "/ara",
              inputName: "yanit",
              submitLabel: "Gönder",
              hiddenFields: conversationFields,
            }}
          />
        ) : null}

        {plan.mode === "conversation" ? (
          <SearchIntentChips
            headingId="anlasilanlar"
            heading="Aramanda dikkate alınanlar"
            chips={plan.understood.map((chip) => ({
              key: chip.key,
              label: chip.label,
              removeHref: chip.removeSteps ? stepsHref(chip.removeSteps) : null,
            }))}
          />
        ) : null}

        {plan.mode === "conversation" && !plan.question ? (
          <SearchConversationInput
            id="aramayi-daralt"
            label="Aramayı daralt"
            placeholder="Örneğin: siyah olsun, 5.000 TL'yi geçmesin"
            submitLabel="Uygula"
            action="/ara"
            inputName="yanit"
            hiddenFields={conversationFields}
          />
        ) : null}

        {plan.mode === "conventional" &&
        needsClarification &&
        candidateCategories &&
        candidateCategories.length > 0 ? (
          <ClarificationBar
            intro="Hangisini arıyorsun?"
            candidates={candidateCategories.map((id) => ({
              label: `Kategori ${id}`,
              href: `/ara?q=${encodeURIComponent(query)}&kategori=${id}`,
            }))}
            otherLabel="Başka bir şey"
            otherPlaceholder="Ne arıyorsun?"
            searchAction="/ara"
            queryParamName="q"
          />
        ) : null}

        <SortTabs tabs={tabs} />
      </div>

      {isFallback ? (
        <>
          <EmptyState
            className={styles.emptyPanel}
            title="Bu aramada sonuç bulamadık."
            description="Daha genel bir arama dene: fiyat, renk ya da beden gibi ayrıntıları çıkarabilir veya farklı kelimeler kullanabilirsin."
            headingLevel={2}
          />
          {items.length > 0 ? (
            <section className={styles.section} aria-labelledby="en-yakin-sonuclar">
              <h2 id="en-yakin-sonuclar" className={styles.sectionTitle}>
                Sana en yakın bulduklarımız
              </h2>
              <ResultGrid items={items} labelledBy="en-yakin-sonuclar" />
            </section>
          ) : null}
        </>
      ) : (
        <ResultGrid items={items} />
      )}

      {!isFallback && result.total > PAGE_SIZE ? (
        <nav className={styles.pagination} aria-label="Sayfalama">
          {page > 1 ? (
            <a
              href={pageHref(page - 1)}
              rel="prev"
              className={styles.pageLink}
              aria-label="Önceki sayfa"
            >
              Önceki
            </a>
          ) : null}
          <p className={styles.pageStatus}>
            Sayfa {page} / {totalPages}
          </p>
          {page * PAGE_SIZE < result.total ? (
            <a
              href={pageHref(page + 1)}
              rel="next"
              className={styles.pageLink}
              aria-label="Sonraki sayfa"
            >
              Sonraki
            </a>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
