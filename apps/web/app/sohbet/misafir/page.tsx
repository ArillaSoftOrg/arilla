import type { ClarificationInput, ClarificationQuestion, QueryObject } from "@arilla/core";
import {
  compileQuery,
  createPostgresSearchProvider,
  createSeedAliasSource,
  DEFAULT_CLARIFICATION_REGISTRY,
  decodeInputs,
  encodeInput,
  findDomain,
  loadLexicon,
  replayConversation,
  resolveQuery,
  searchWithFallback,
  stripConversationalSearchFillers,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { SearchWallGateClient } from "../../ara/search-wall-gate-client.tsx";
import { verifySession } from "../../lib/dal.ts";
import { startConversationAction } from "../actions.ts";
import { CHAT_COPY } from "../chat-copy.ts";
import { ChatResultGrid } from "../chat-results.tsx";
import { ChatPendingRow, ChatUserRow } from "../chat-shell-parts.tsx";
import styles from "../sohbet.module.css";
import { GuestComposer } from "./guest-composer-client.tsx";

const GUEST_RESULT_LIMIT = 6;

function guestHref(query: string, steps: readonly ClarificationInput[]): string {
  const params = new URLSearchParams({ q: query });
  for (const step of steps) params.append("n", encodeInput(step));
  return `/sohbet/misafir?${params.toString()}`;
}

function answerLabel(questionId: string, optionId: string): string | null {
  for (const domain of DEFAULT_CLARIFICATION_REGISTRY.domains) {
    const option = domain.facets
      .find((facet) => facet.id === questionId)
      ?.options.find((candidate) => candidate.id === optionId);
    if (option) return option.label;
  }
  return null;
}

function GuestQuestion({
  query,
  steps,
  question,
}: {
  query: string;
  steps: readonly ClarificationInput[];
  question: ClarificationQuestion;
}) {
  return (
    <section className={styles.question} aria-labelledby="misafir-soru">
      <h2 id="misafir-soru" className={styles.questionTitle}>
        {question.text}
      </h2>
      <ul className={styles.options}>
        {question.options.map((option) => (
          <li key={option.id}>
            <a
              className={styles.option}
              href={guestHref(query, [
                ...steps,
                { type: "answer", questionId: question.id, optionId: option.id },
              ])}
            >
              <span className={styles.optionLabel}>{option.label}</span>
            </a>
          </li>
        ))}
      </ul>
      <div className={styles.questionActions}>
        <a
          className={`${styles.secondaryAction} ${styles.skip}`}
          href={guestHref(query, [...steps, { type: "skip", questionId: question.id }])}
        >
          {question.skipOption.label}
        </a>
        <a
          className={styles.secondaryAction}
          href={guestHref(query, [...steps, { type: "show_results" }])}
        >
          Sonuçları göster
        </a>
      </div>
    </section>
  );
}

async function GuestResults({ parsed, next }: { parsed: QueryObject; next: string }) {
  const db = getDatabase();
  const result = await searchWithFallback(
    createPostgresSearchProvider(db),
    { parsed: { ...parsed, sort: "balanced" }, sort: "balanced", page: 1, pageSize: 6 },
    { aliases: createSeedAliasSource() },
  );
  const items = result.items.slice(0, GUEST_RESULT_LIMIT);
  const headingId = "misafir-sonuclari";

  return (
    <>
      <div className={`${styles.row} ${styles.rowAssistant}`}>
        <div className={styles.assistantBody}>
          <p className={`${styles.bubble} ${styles.bubbleAssistant}`}>
            {items.length > 0
              ? "İsteğine uygun seçenekleri buldum."
              : "Bu tarifle birebir eşleşme bulamadım; birlikte biraz daha netleştirebiliriz."}
          </p>
          {items.length > 0 ? (
            <section className={styles.results} aria-labelledby={headingId}>
              <h2 id={headingId} className={styles.resultsHeading}>
                Sana uygun seçenekler
              </h2>
              <ChatResultGrid items={items} labelledBy={headingId} />
            </section>
          ) : null}
        </div>
      </div>
      <SearchWallGateClient show resultGate next={next} />
    </>
  );
}

/**
 * Dupe-benzeri misafir girisi: kullanici once chat kabugunu ve hazirlanan
 * sonuclari gorur; hesap kapisi sonuc aninda ayni ekranin uzerine gelir.
 */
export default async function GuestChatPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; n?: string | string[] }>;
}) {
  const params = await searchParams;
  const query = params.q?.trim().slice(0, 500) ?? "";
  if (!query) redirect("/");

  const encodedSteps = Array.isArray(params.n) ? params.n : params.n ? [params.n] : [];
  const steps = decodeInputs(encodedSteps);
  const db = getDatabase();
  const lexicon = await loadLexicon(db);
  const { decision } = replayConversation([{ type: "text", text: query }, ...steps], {
    registry: DEFAULT_CLARIFICATION_REGISTRY,
    lexicon,
  });

  const user = await verifySession();
  if (user) {
    const data = new FormData();
    const compiled = compileQuery(decision.state, DEFAULT_CLARIFICATION_REGISTRY);
    data.set("q", compiled.unparsed || query);
    await startConversationAction(data);
  }

  const answerRows = steps.flatMap((step) => {
    if (step.type === "answer") {
      const label = answerLabel(step.questionId, step.optionId);
      return label ? [{ key: encodeInput(step), text: label }] : [];
    }
    if (step.type === "skip") return [{ key: encodeInput(step), text: "Fark etmez" }];
    if (step.type === "text") return [{ key: encodeInput(step), text: step.text }];
    return [];
  });

  let parsed: QueryObject | null = null;
  if (decision.action === "search") {
    const domain = findDomain(DEFAULT_CLARIFICATION_REGISTRY, decision.state.domainId);
    if (domain) {
      parsed = compileQuery(decision.state, DEFAULT_CLARIFICATION_REGISTRY);
    } else {
      const catalogQuery = stripConversationalSearchFillers(query) || query;
      ({ parsed } = await resolveQuery(db, catalogQuery));
    }
  }

  return (
    <div className={styles.chat}>
      <ol className={styles.thread} aria-label={CHAT_COPY.threadLabel}>
        <ChatUserRow text={query} />
        {answerRows.map((answer) => (
          <ChatUserRow key={answer.key} text={answer.text} />
        ))}
      </ol>
      {decision.action === "clarify" ? (
        <GuestQuestion query={query} steps={steps} question={decision.question} />
      ) : parsed ? (
        <Suspense fallback={<ChatPendingRow />}>
          <GuestResults parsed={parsed} next={guestHref(query, steps)} />
        </Suspense>
      ) : null}
      <div className={styles.bottom} aria-hidden="true" />
      <GuestComposer
        query={query}
        steps={steps.map(encodeInput)}
        locked={decision.action !== "clarify"}
      />
    </div>
  );
}
