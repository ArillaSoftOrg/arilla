"use client";

import type { ClarifyQuestion } from "@arilla/core";
import { ArrowRightIcon, Button, VisuallyHidden } from "@arilla/ui";
import { useRouter } from "next/navigation";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { runTurnAction, type SendMessageStatus, sendMessageAction } from "./actions.ts";
import { CHAT_COPY, CHAT_ERROR_COPY, type ChatErrorKind, errorKindForStatus } from "./chat-copy.ts";
import styles from "./sohbet.module.css";

type SendRequest =
  | { kind: "text"; text: string }
  | { kind: "option"; questionId: string; value: string }
  | { kind: "skip"; questionId: string };

/** Meşgul (`busy`) dönen turu en çok bu kadar bekleriz: 20 x 1,5 sn. */
const MAX_BUSY_POLLS = 20;
const BUSY_POLL_MS = 1500;
const MAX_LENGTH = 500;

function newRequestKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Props {
  conversationId: string;
  /** Son mesaj kullanıcınındır: asistan yanıtı bekleniyor (ilk mesaj, yenileme, hata sonrası). */
  awaitingReply: boolean;
  /** Açık netlestirme sorusu; yalnızca son mesaj o soruysa dolu. */
  question: ClarifyQuestion | null;
  /** Hata durumunda `Doğrudan ara` bağlantısı için son kullanıcı metni. */
  lastUserText: string | null;
  /** Son mesajın sırası; yeni mesaj gelince aşağı kaydırmak için. */
  lastSeq: number;
  /** Sunucuda çizilen geçmiş (mesajlar ve ürün sonuçları). */
  children: ReactNode;
}

/**
 * Sohbetin etkileşimli parçası. İş mantığı yok (CLAUDE.md kural 6): her şey
 * sunucu eylemleri üzerinden `packages/core`a gider; burada yalnızca durum
 * (gönderiliyor, hata) ve odak yönetimi vardır.
 *
 * Akış: gönder -> `sendMessageAction` (kaydeder) -> `router.refresh()` (kullanıcı
 * mesajı görünür) -> `runTurnAction` (model) -> `router.refresh()` (yanıt görünür).
 * `runTurnAction` tekrar-güvenlidir; sayfa yenileme, çift sekme ve hata sonrası
 * "tekrar dene" aynı eylemi çağırır.
 */
export function ChatInteractive({
  conversationId,
  awaitingReply,
  question,
  lastUserText,
  lastSeq,
  children,
}: Props) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<ChatErrorKind | null>(null);
  const workingRef = useRef(false);
  const keyRef = useRef<{ signature: string; key: string } | null>(null);
  const autoStartedRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);
  const questionId = useId();

  /** Cevaplanmamış mesajı yorumlatır; meşgulse bekler. Hata durumunu kendisi yazar. */
  async function runTurn(): Promise<void> {
    try {
      for (let attempt = 0; attempt < MAX_BUSY_POLLS; attempt++) {
        const { status } = await runTurnAction(conversationId);
        if (status === "busy") {
          await sleep(BUSY_POLL_MS);
          continue;
        }
        const kind = errorKindForStatus(status);
        if (kind) setError(kind);
        router.refresh();
        return;
      }
      setError("busy");
    } catch {
      setError("network");
    }
  }

  /** Tek giriş kapısı: aynı anda tek eylem, çift gönderim engellenir. */
  async function run(action: () => Promise<void>): Promise<void> {
    if (workingRef.current) return;
    workingRef.current = true;
    setWorking(true);
    setError(null);
    try {
      await action();
    } finally {
      workingRef.current = false;
      setWorking(false);
    }
  }

  async function send(request: SendRequest): Promise<boolean> {
    let sent = false;
    await run(async () => {
      // Aynı yük yeniden gönderilirse (ağ hatası sonrası) aynı anahtar: sunucu bir kez kabul eder.
      const signature = JSON.stringify(request);
      const key = keyRef.current?.signature === signature ? keyRef.current.key : newRequestKey();
      keyRef.current = { signature, key };
      let status: SendMessageStatus;
      try {
        ({ status } = await sendMessageAction(conversationId, request, key));
      } catch {
        setError("network");
        return;
      }
      const kind = errorKindForStatus(status);
      if (kind) {
        setError(kind);
        if (kind === "invalid_option") router.refresh();
        return;
      }
      keyRef.current = null;
      sent = true;
      setDraft("");
      setCustom("");
      setCustomOpen(false);
      router.refresh();
      await runTurn();
    });
    return sent;
  }

  async function retry(): Promise<void> {
    await run(async () => {
      await runTurn();
    });
  }

  // Sayfa yüklendiğinde cevaplanmamış mesaj varsa (ilk mesaj, yenileme) tur başlatılır.
  // biome-ignore lint/correctness/useExhaustiveDependencies: yalnızca bir kez, ilk yüklemede.
  useEffect(() => {
    if (!awaitingReply || autoStartedRef.current) return;
    autoStartedRef.current = true;
    void retry();
  }, []);

  // Yeni mesaj ya da durum gelince son içeriğe kaydır (hareket tercihine saygı).
  // biome-ignore lint/correctness/useExhaustiveDependencies: kaydırma tetikleyicileri bilinçli.
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    bottomRef.current?.scrollIntoView({ block: "end", behavior: reduce ? "auto" : "smooth" });
  }, [lastSeq, working, error]);

  useEffect(() => {
    if (customOpen) customInputRef.current?.focus();
  }, [customOpen]);

  function submitDraft(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || working || awaitingReply) return;
    void send({ kind: "text", text });
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter gönderir, Shift+Enter satır ekler; IME birleştirme sırasında göndermez.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submitDraft();
    }
  }

  function submitCustom(event: FormEvent) {
    event.preventDefault();
    const text = custom.trim();
    if (!text || working) return;
    void send({ kind: "text", text });
  }

  const errorCopy = error ? CHAT_ERROR_COPY[error] : null;
  // Yanıt beklerken (ya da hata sonrası bekleyen mesaj varken) yeni mesaj yazılamaz.
  const composerLocked = working || awaitingReply;
  const showThinking = working || (awaitingReply && error === null);
  const showQuestion = question !== null && !awaitingReply && !working;

  return (
    <div className={styles.chat}>
      {children}

      {showThinking ? (
        <div className={`${styles.row} ${styles.rowAssistant}`}>
          <p
            className={`${styles.bubble} ${styles.bubbleAssistant} ${styles.thinking}`}
            role="status"
          >
            <span className={styles.dots} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            {CHAT_COPY.thinking}
          </p>
        </div>
      ) : null}

      {showQuestion && question ? (
        <section className={styles.question} aria-labelledby={questionId}>
          <h2 id={questionId} className={styles.questionTitle}>
            {question.title}
          </h2>
          <ul className={styles.options}>
            {question.options.map((option) => (
              <li key={option.value}>
                <button
                  type="button"
                  className={styles.option}
                  disabled={working}
                  onClick={() =>
                    void send({ kind: "option", questionId: question.id, value: option.value })
                  }
                >
                  <span className={styles.optionLabel}>{option.label}</span>
                  {option.description ? (
                    <span className={styles.optionDescription}>{option.description}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
          <div className={styles.questionActions}>
            {question.allowCustomAnswer ? (
              <button
                type="button"
                className={styles.secondaryAction}
                aria-expanded={customOpen}
                disabled={working}
                onClick={() => setCustomOpen((open) => !open)}
              >
                {CHAT_COPY.otherLabel}
              </button>
            ) : null}
            {question.skippable ? (
              <button
                type="button"
                className={`${styles.secondaryAction} ${styles.skip}`}
                disabled={working}
                onClick={() => void send({ kind: "skip", questionId: question.id })}
              >
                {CHAT_COPY.skipLabel}
              </button>
            ) : null}
          </div>
          {customOpen ? (
            <form className={styles.customForm} onSubmit={submitCustom}>
              <label className={styles.customLabel}>
                <VisuallyHidden as="span">{CHAT_COPY.otherInputLabel}</VisuallyHidden>
                <input
                  ref={customInputRef}
                  className={styles.customInput}
                  type="text"
                  value={custom}
                  maxLength={MAX_LENGTH}
                  placeholder={CHAT_COPY.otherPlaceholder}
                  autoComplete="off"
                  enterKeyHint="send"
                  disabled={working}
                  onChange={(event) => setCustom(event.target.value)}
                />
              </label>
              <Button type="submit" variant="accent" disabled={working || custom.trim() === ""}>
                {CHAT_COPY.otherSubmit}
              </Button>
            </form>
          ) : null}
        </section>
      ) : null}

      {errorCopy ? (
        <div className={styles.error} role="alert">
          <p className={styles.errorMessage}>{errorCopy.message}</p>
          <div className={styles.errorActions}>
            {errorCopy.retry ? (
              <Button
                variant="accent"
                disabled={working}
                onClick={() => void (awaitingReply ? retry() : router.refresh())}
              >
                {CHAT_COPY.retryLabel}
              </Button>
            ) : null}
            {errorCopy.searchDirectly && lastUserText ? (
              <a
                className={styles.errorLink}
                href={`/ara?${new URLSearchParams({ q: lastUserText }).toString()}`}
              >
                {CHAT_COPY.searchDirectlyLabel}
              </a>
            ) : null}
            {errorCopy.newChat ? (
              <a className={styles.errorLink} href="/">
                {CHAT_COPY.newChatLabel}
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      <div ref={bottomRef} className={styles.bottom} aria-hidden="true" />

      <form className={styles.composer} onSubmit={submitDraft}>
        <label className={styles.composerLabel}>
          <VisuallyHidden as="span">{CHAT_COPY.composerLabel}</VisuallyHidden>
          <textarea
            className={styles.composerInput}
            rows={1}
            value={draft}
            maxLength={MAX_LENGTH}
            placeholder={CHAT_COPY.composerPlaceholder}
            disabled={composerLocked}
            enterKeyHint="send"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
          />
        </label>
        <Button
          type="submit"
          variant="accent"
          className={styles.send}
          aria-label={working ? CHAT_COPY.sending : CHAT_COPY.sendLabel}
          disabled={composerLocked || draft.trim() === ""}
        >
          <ArrowRightIcon />
        </Button>
      </form>
    </div>
  );
}
