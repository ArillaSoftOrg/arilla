import {
  type ConversationPlan,
  loadLexicon,
  planConversation,
  type ReplyResult,
  type SortMode,
} from "@arilla/core";
import { DEFAULT_CLARIFICATION_REGISTRY } from "@arilla/core/clarification";
import { type Database, getDatabase } from "@arilla/db";
import {
  ClarificationQuestion,
  SearchConversationInput,
  SearchConversationNotice,
  SearchForm,
  SearchIntentChips,
} from "@arilla/ui";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PhotoSearchButton } from "../photo-search-client.tsx";
import styles from "./ara.module.css";
import { ConversationFocusClient } from "./conversation-focus-client.tsx";
import { ResultsRegionSkeleton } from "./search-results.tsx";
import { TextSearchResults } from "./text-search-results.tsx";

const SORT_MODES: readonly SortMode[] = ["balanced", "best_deal", "closest_match"];

function isSortMode(value: string | undefined): value is SortMode {
  return SORT_MODES.includes(value as SortMode);
}

const SEARCH_PLACEHOLDER = "Ürün adı, marka ya da kısa bir tarif yaz";

/**
 * Konusma eyleminden (secenek, cip kaldirma, serbest yanit) sonra odagi
 * tasimak icin parca. Bkz. conversation-focus-client.tsx.
 */
const FOCUS_FRAGMENT = "#konusma";
const NOTICE_ID = "konusma-bildirim";
const QUESTION_HEADING_ID = "netlestirme-sorusu";
const CONSTRAINTS_HEADING_ID = "aramada-kullanilanlar";
const CONTEXT_HEADING_ID = "tercihlerin";
const REFINE_INPUT_ID = "aramayi-daralt";
const QUESTION_INPUT_ID = `${QUESTION_HEADING_ID}-serbest`;
const TITLE_ID = "arama-basligi";

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
  /**
   * Soru ya da daraltma kutusundan gelen serbest yanit. Uygulandiysa kanonik
   * URL'e yonlendirilir; anlasilmadiysa URL'de kalir ve not gosterilir.
   */
  yanit?: string;
  /** Uygulanan yanitin yaninda karsiligi olmayan bir fiyat tercihi vardi. */
  uyari?: string;
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
  notice,
  focus,
}: {
  query: string;
  steps: readonly string[];
  sort?: SortMode;
  page?: number;
  notice?: "fiyat";
  focus?: boolean;
}): string {
  const params = new URLSearchParams({ q: query });
  for (const step of steps) params.append("n", step);
  if (sort && sort !== "balanced") params.set("sort", sort);
  if (page && page > 1) params.set("sayfa", String(page));
  if (notice) params.set("uyari", notice);
  return `/ara?${params.toString()}${focus ? FOCUS_FRAGMENT : ""}`;
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
    return { mode: "conventional", query: request.query, reason: "no_domain", reply: null };
  }
}

/** Yaniti uygulandigi icin URL'e yazilan ve yonlendirilen sonuclar. */
function isStoredReply(reply: ReplyResult | null): boolean {
  return reply?.outcome === "applied" || reply?.outcome === "new_search";
}

/**
 * Serbest yanit hicbir zaman sessizce yutulmaz. Uygulananlar URL'e yazilir
 * ve ciplerde gorunur; digerleri icin durustce ne oldugu soylenir.
 */
function replyNotice(
  reply: ReplyResult | null,
  priceNotice: boolean,
  inputId: string,
): { message: string; detail?: string; actions: { label: string; href: string }[] } | null {
  if (reply?.outcome === "unrecognized") {
    return {
      message: `“${reply.text}” ifadesini bu aramaya nasıl uygulayacağımı anlayamadım.`,
      detail: "İstersen bunu yeni bir arama olarak deneyebilir ya da yazdığını değiştirebilirsin.",
      actions: [
        {
          label: "Yeni arama olarak kullan",
          href: `/ara?${new URLSearchParams({ q: reply.text }).toString()}`,
        },
        { label: "Değiştir", href: `#${inputId}` },
      ],
    };
  }
  if (reply?.outcome === "unsupported_preference" || priceNotice) {
    return {
      message: "Sonuçları fiyata göre öne almayı henüz buradan yapamıyorum.",
      detail: "Bir üst sınır yazarsan aramaya eklerim, örneğin “en fazla 2.000 TL”.",
      actions:
        reply?.outcome === "unsupported_preference"
          ? [{ label: "Değiştir", href: `#${inputId}` }]
          : [],
    };
  }
  return null;
}

/**
 * docs/pages.md "/ara": arama girdisi -> netleştirme (varsa) -> sonuç sayısı
 * -> sekmeler -> sonuç ızgarası -> sayfalama. Giriş modali (decision 0002,
 * E2) sonuç bölgesinde; görsel arama sonucu ayrı bir rotada (`/ara/gorsel`),
 * yükleme girdisi burada (D4).
 *
 * Yükleniyor: yalnızca sonuca bağlı bölge (`TextSearchResults`) iskelete
 * döner. Arama kutusu, soru ve anlaşılan çipler yerinde kalır; bu yüzden
 * bu segmentte sayfa düzeyinde `loading.tsx` yok.
 */
export default async function AramaPage({
  searchParams,
}: {
  searchParams: Promise<AramaSearchParams>;
}) {
  const { q, sort: sortParam, sayfa, n, yanit, uyari } = await searchParams;
  const requestedQuery = q?.trim() ?? "";
  const requestedSteps = toList(n);
  const replyText = yanit?.trim() || null;

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
  const plan = await planSafely(db, {
    query: requestedQuery,
    steps: requestedSteps,
    reply: replyText,
  });
  const query = plan.query;
  const steps = plan.mode === "conversation" ? plan.steps : [];
  const requestedSort = isSortMode(sortParam) ? sortParam : "balanced";
  // Metin aramasinda "En yakın eşleşmeler" devre disi (anchor yok); konusma
  // linkleri gecersiz bir siralamayi tasimasin.
  const conversationSort: SortMode = requestedSort === "closest_match" ? "balanced" : requestedSort;

  // Uygulanan yanit ve bayat adimlar kanonik URL'e cevrilir: geri tusu ve
  // paylasilan link ayni konusmayi kurar, `yanit` URL'de kalmaz. Anlasilmayan
  // yanit ise URL'de kalir ki not gosterilsin ve kutu geri doldurulsun.
  const replyStored = isStoredReply(plan.reply);
  if (
    (replyText !== null && (plan.reply === null || replyStored)) ||
    query !== requestedQuery ||
    (plan.mode === "conversation" && plan.droppedInvalidStep) ||
    (plan.mode === "conventional" && requestedSteps.length > 0)
  ) {
    redirect(
      aramaHref({
        query,
        steps,
        sort: conversationSort,
        notice: replyStored && plan.reply?.ignoredPricePreference ? "fiyat" : undefined,
        focus: replyText !== null,
      }),
    );
  }

  const page = Math.max(1, Number.parseInt(sayfa ?? "1", 10) || 1);

  function stepsHref(nextSteps: readonly string[]): string {
    return aramaHref({ query, steps: nextSteps, sort: conversationSort, focus: true });
  }

  const conversationFields = [
    { name: "q", value: query },
    ...steps.map((value) => ({ name: "n", value })),
    ...(conversationSort !== "balanced" ? [{ name: "sort", value: conversationSort }] : []),
  ];

  const question = plan.mode === "conversation" ? plan.question : null;
  const inputId = question ? QUESTION_INPUT_ID : REFINE_INPUT_ID;
  const notice =
    plan.mode === "conversation" ? replyNotice(plan.reply, uyari === "fiyat", inputId) : null;
  // Anlasilmayan yanit kutuya geri doldurulur; kullanici duzeltip tekrar gonderir.
  const unrecognizedText =
    plan.mode === "conversation" && plan.reply && !isStoredReply(plan.reply)
      ? plan.reply.text
      : undefined;
  const noticeElement = notice ? (
    <SearchConversationNotice
      id={NOTICE_ID}
      message={notice.message}
      detail={notice.detail}
      actions={notice.actions}
    />
  ) : null;

  return (
    <div className={styles.page}>
      <ConversationFocusClient
        targets={[
          NOTICE_ID,
          QUESTION_HEADING_ID,
          CONSTRAINTS_HEADING_ID,
          CONTEXT_HEADING_ID,
          "sonuc-sayisi",
          TITLE_ID,
        ]}
      />
      <SearchToolbar query={query} />

      <header className={styles.header}>
        <h1 id={TITLE_ID} className={styles.title}>
          “{query}” için sonuçlar
        </h1>
      </header>

      {plan.mode === "conversation" ? (
        <div id="konusma" className={styles.controls}>
          {question ? (
            <>
              {noticeElement}
              <ClarificationQuestion
                headingId={QUESTION_HEADING_ID}
                question={question.text}
                options={question.options.map((option) => ({
                  id: option.id,
                  label: option.label,
                  selected: option.selected,
                  href: stepsHref(option.steps),
                }))}
                skip={{ label: question.skip.label, href: stepsHref(question.skip.steps) }}
                showResults={{
                  label: question.showResults.label,
                  href: stepsHref(question.showResults.steps),
                }}
                freeText={{
                  label: "Ya da kendi cümlenle yaz",
                  placeholder: "Kısaca yaz",
                  action: `/ara${FOCUS_FRAGMENT}`,
                  inputName: "yanit",
                  submitLabel: "Gönder",
                  hiddenFields: conversationFields,
                  defaultValue: unrecognizedText,
                  describedBy: notice ? NOTICE_ID : undefined,
                }}
              />
            </>
          ) : null}

          <SearchIntentChips
            headingId={CONSTRAINTS_HEADING_ID}
            heading="Aramada kullanılanlar"
            chips={plan.constraints.map((chip) => ({
              key: chip.key,
              label: chip.label,
              removeHref: chip.removeSteps ? stepsHref(chip.removeSteps) : null,
            }))}
          />

          {/* Yalnizca sonraki soruyu belirleyen tercihler; katalog bunlarla
              filtrelenmez, bu yuzden filtre gibi adlandirilmaz. */}
          <SearchIntentChips
            headingId={CONTEXT_HEADING_ID}
            heading="Tercihlerin"
            removeLabelSuffix="tercihini kaldır"
            chips={plan.context.map((chip) => ({
              key: chip.key,
              label: chip.label,
              removeHref: chip.removeSteps ? stepsHref(chip.removeSteps) : null,
            }))}
          />

          {!question ? (
            <>
              {noticeElement}
              <SearchConversationInput
                id={REFINE_INPUT_ID}
                label="Aramayı daralt"
                placeholder="Ek tercih yaz"
                submitLabel="Uygula"
                action={`/ara${FOCUS_FRAGMENT}`}
                inputName="yanit"
                hiddenFields={conversationFields}
                defaultValue={unrecognizedText}
                describedBy={notice ? NOTICE_ID : undefined}
              />
            </>
          ) : null}
        </div>
      ) : null}

      <Suspense fallback={<ResultsRegionSkeleton statusLabel="Sonuçlar yükleniyor" />}>
        <TextSearchResults
          query={query}
          queryObject={plan.mode === "conversation" ? plan.queryObject : null}
          isNewSearch={steps.length === 0 && replyText === null}
          requestedSort={requestedSort}
          page={page}
          hrefFor={({ sort, page: target }) => aramaHref({ query, steps, sort, page: target })}
        />
      </Suspense>
    </div>
  );
}
