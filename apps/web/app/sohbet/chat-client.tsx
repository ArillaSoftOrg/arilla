"use client";

import type { AssistantPreview, ClarifyQuestion } from "@arilla/core";
import {
  Button,
  isSubmitKey,
  ProductCardSkeleton,
  resolveComposerSubmit,
  VisuallyHidden,
} from "@arilla/ui";
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
import { validateAttachmentFile } from "../home-image-chat.ts";
import {
  getTurnStatusAction,
  runTurnAction,
  type SendMessageStatus,
  sendMessageAction,
} from "./actions.ts";
import { CHAT_COPY, CHAT_ERROR_COPY, type ChatErrorKind, errorKindForStatus } from "./chat-copy.ts";
import { chatMark } from "./chat-metrics.ts";
import { CHAT_MESSAGE_MAX, ChatComposer, ChatPendingRow } from "./chat-shell-parts.tsx";
import styles from "./sohbet.module.css";

type SendRequest =
  | { kind: "text"; text: string }
  | { kind: "option"; questionId: string; value: string }
  | { kind: "skip"; questionId: string };

/** Meşgul (`busy`) dönen turu en çok bu kadar bekleriz: 20 x 1,5 sn. */
const MAX_BUSY_POLLS = 20;
const BUSY_POLL_MS = 1500;
const MAX_LENGTH = CHAT_MESSAGE_MAX;
/** Ilk tur sunucuda `after()` ile calisir; bu sure icinde baslamadiysa kurtarma devreye girer. */
const RECOVERY_GRACE_MS = 2500;
const WAIT_POLL_MS = 700;
const MAX_WAIT_POLLS = 110;

function newRequestKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Karar 0091: mesaja eklenmek uzere secilmis, henuz gonderilmemis fotograf. */
interface StagedImage {
  file: File;
  url: string;
  /** Her yeni secim yeni anahtar; ayni secimin yeniden gonderimi sunucuda tekillesir. */
  key: string;
}

interface Props {
  conversationId: string;
  /** `CHAT_IMAGE_ENABLED`: kapaliysa "+" hic gorunmez ve eski aramaya dusulmez. */
  imageEnabled: boolean;
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
  imageEnabled,
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
  const [staged, setStaged] = useState<StagedImage | null>(null);
  const stagedUrlRef = useRef<string | null>(null);
  // Sunucu cevabi yazdi ama tam sayfa yenilemesi (urun sonuclari) henuz gelmedi:
  // cevap metni hemen gorunur. `lastSeq` ilerleyince (yenileme geldi) kendiliginden gizlenir.
  const [preview, setPreview] = useState<AssistantPreview | null>(null);
  const workingRef = useRef(false);
  const keyRef = useRef<{ signature: string; key: string } | null>(null);
  const autoStartedRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);
  const questionId = useId();

  // Onizleme blob'u: degisince/kalkinca/unmount'ta serbest birakilir.
  useEffect(() => {
    stagedUrlRef.current = staged?.url ?? null;
  }, [staged]);
  useEffect(
    () => () => {
      if (stagedUrlRef.current) URL.revokeObjectURL(stagedUrlRef.current);
    },
    [],
  );

  function stageFile(file: File): void {
    if (workingRef.current) return;
    const invalid = validateAttachmentFile(file);
    if (invalid === "invalid_type" || invalid === "too_large") {
      setError(invalid);
      return;
    }
    setError(null);
    if (stagedUrlRef.current) URL.revokeObjectURL(stagedUrlRef.current);
    setStaged({ file, url: URL.createObjectURL(file), key: newRequestKey() });
  }

  function clearStaged(): void {
    if (stagedUrlRef.current) URL.revokeObjectURL(stagedUrlRef.current);
    stagedUrlRef.current = null;
    setStaged(null);
  }

  function removeStaged(): void {
    if (workingRef.current) return;
    clearStaged();
    setError(null);
  }

  function showPreview(answer: AssistantPreview): void {
    chatMark("chat:assistant_visible");
    setPreview(answer);
  }

  /**
   * Ilk tur sunucuda zaten calisiyor (`after()`): ikinci bir Gemini cagrisi
   * baslatmadan hafif durum sorgusuyla bekler. Tur hic baslamadiysa (kira yok,
   * `RECOVERY_GRACE_MS` doldu) `runTurn` kurtarma olarak calisir; kira tek
   * Gemini cagrisini garanti eder.
   */
  async function waitForTurn(): Promise<void> {
    const startedAt = Date.now();
    try {
      for (let poll = 0; poll < MAX_WAIT_POLLS; poll++) {
        const status = await getTurnStatusAction(conversationId);
        if (status.state === "answered") {
          if (status.preview) showPreview(status.preview);
          router.refresh();
          return;
        }
        if (status.state === "not_found" || status.state === "unavailable") {
          setError(status.state);
          return;
        }
        if (status.state === "pending" && Date.now() - startedAt >= RECOVERY_GRACE_MS) {
          await runTurn();
          return;
        }
        await sleep(WAIT_POLL_MS);
      }
      setError("busy");
    } catch {
      setError("network");
    }
  }

  /** Cevaplanmamış mesajı yorumlatır; meşgulse bekler. Hata durumunu kendisi yazar. */
  async function runTurn(): Promise<void> {
    try {
      for (let attempt = 0; attempt < MAX_BUSY_POLLS; attempt++) {
        const { status, preview: answer } = await runTurnAction(conversationId);
        if (status === "busy") {
          await sleep(BUSY_POLL_MS);
          continue;
        }
        const kind = errorKindForStatus(status);
        if (kind) setError(kind);
        else if (answer) showPreview(answer);
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

  async function send(request: SendRequest, image?: StagedImage): Promise<boolean> {
    let sent = false;
    await run(async () => {
      // Aynı yük yeniden gönderilirse (ağ hatası sonrası) aynı anahtar: sunucu bir kez kabul eder.
      // Görselli mesajda aynı seçim aynı anahtarı taşır (karar 0091).
      const signature = JSON.stringify(image ? { ...request, image: image.key } : request);
      const key = keyRef.current?.signature === signature ? keyRef.current.key : newRequestKey();
      keyRef.current = { signature, key };
      let status: SendMessageStatus;
      try {
        if (image) {
          const photo = new FormData();
          photo.set("photo", image.file);
          ({ status } = await sendMessageAction(conversationId, request, key, photo));
        } else {
          ({ status } = await sendMessageAction(conversationId, request, key));
        }
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
      clearStaged();
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
    // Normal yol: ilk tur sunucuda zaten basladi, yalnizca beklenir. Baslamadiysa kurtarma.
    void run(waitForTurn);
  }, []);

  // Yeni mesaj ya da durum gelince son içeriğe kaydır (hareket tercihine saygı).
  // biome-ignore lint/correctness/useExhaustiveDependencies: kaydırma tetikleyicileri bilinçli.
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    bottomRef.current?.scrollIntoView({ block: "end", behavior: reduce ? "auto" : "smooth" });
  }, [lastSeq, working, error, preview]);

  // Sunucu yenilemesi geldi (kalici cevap + urunler): olcum isareti.
  useEffect(() => {
    if (preview && preview.seq <= lastSeq) chatMark("chat:render_ready");
  }, [lastSeq, preview]);

  useEffect(() => {
    if (customOpen) customInputRef.current?.focus();
  }, [customOpen]);

  function submitDraft(event?: FormEvent) {
    event?.preventDefault();
    // Ana sayfa kutusuyla AYNI kural: metin ya da fotograf yeterli, ikisi de yoksa hicbir sey olmaz.
    const decision = resolveComposerSubmit({
      text: draft,
      hasImage: staged !== null,
      busy: working || awaitingReply,
    });
    if (decision === "noop") return;
    void send({ kind: "text", text: draft.trim() }, staged ?? undefined);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter gönderir, Shift+Enter satır ekler; IME birleştirme sırasında göndermez.
    if (
      isSubmitKey({
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.keyCode,
      })
    ) {
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

      {preview && preview.seq > lastSeq ? (
        <>
          <div className={`${styles.row} ${styles.rowAssistant}`}>
            <VisuallyHidden as="span">{CHAT_COPY.assistantLabel}: </VisuallyHidden>
            <p className={`${styles.bubble} ${styles.bubbleAssistant}`}>{preview.content}</p>
          </div>
          {preview.kind === "search" ? (
            <div className={styles.results} aria-busy="true">
              <VisuallyHidden as="p" role="status">
                {CHAT_COPY.resultsLoading}
              </VisuallyHidden>
              <div className={styles.resultGrid} aria-hidden="true">
                {Array.from({ length: 6 }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: sabit sayıda, sırasız iskelet kartı.
                  <ProductCardSkeleton key={i} />
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : showThinking ? (
        <ChatPendingRow />
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

      <ChatComposer
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={submitDraft}
        onKeyDown={onComposerKeyDown}
        locked={composerLocked}
        busy={working}
        attachment={
          imageEnabled
            ? { previewUrl: staged?.url ?? null, onFileSelected: stageFile, onRemove: removeStaged }
            : undefined
        }
      />
    </div>
  );
}
