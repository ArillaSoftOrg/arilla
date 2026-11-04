"use client";

import { Button, ProductCard } from "@arilla/ui";
import Image from "next/image";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ChatIntentControls } from "../sohbet/chat-intent-controls.tsx";
import { ChatCardActions, ChatCompareTray } from "../sohbet/chat-product-cards.tsx";
import { useChatProductTools } from "../sohbet/chat-product-context.tsx";
import { ChatProductToolsProvider } from "../sohbet/chat-product-tools.tsx";
import { ChatComposer, ChatPendingRow, ChatUserRow } from "../sohbet/chat-shell-parts.tsx";
import chat from "../sohbet/sohbet.module.css";
import styles from "./demo.module.css";
import {
  createDemoBackend,
  DEMO_BUDGET,
  DEMO_CARDS,
  DEMO_END,
  DEMO_NOTICE,
  DEMO_PHASES,
  DEMO_QUERY,
  demoChips,
  demoIntent,
} from "./demo-data.ts";

export function HowItWorksDemo() {
  const root = useRef<HTMLElement>(null);
  const elapsedRef = useRef(0);
  const [phase, setPhase] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [replay, setReplay] = useState(0);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState("");
  const [backend, setBackend] = useState(createDemoBackend);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(media.matches);
    setPlaying(!media.matches);
    if (media.matches) setPhase(DEMO_END);
    const change = () => {
      setReducedMotion(media.matches);
      if (media.matches) {
        setPlaying(false);
        setPhase(DEMO_END);
      }
    };
    media.addEventListener("change", change);
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.15)),
      { threshold: 0.15 },
    );
    if (root.current) observer.observe(root.current);
    const visibility = () => setPageVisible(document.visibilityState === "visible");
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      media.removeEventListener("change", change);
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  useEffect(() => {
    if (!playing || !visible || !pageVisible || phase === DEMO_END) return;
    const duration = DEMO_PHASES[phase]?.duration ?? 0;
    const timer = window.setInterval(() => {
      elapsedRef.current += 80;
      if (elapsedRef.current >= duration) {
        window.clearInterval(timer);
        elapsedRef.current = 0;
        setElapsed(0);
        setPhase((current) => Math.min(DEMO_END, current + 1));
      } else setElapsed(elapsedRef.current);
    }, 80);
    return () => window.clearInterval(timer);
  }, [phase, playing, visible, pageVisible]);

  useEffect(() => {
    if (phase === DEMO_END) setPlaying(false);
  }, [phase]);

  function explore() {
    setPlaying(false);
    setPhase(DEMO_END);
  }
  function restart() {
    elapsedRef.current = 0;
    setElapsed(0);
    setPhase(0);
    setDraft("");
    setMessage("");
    setReplay((value) => value + 1);
    setBackend(createDemoBackend());
    setPlaying(true);
  }
  function prepareMessage(text: string) {
    const next = draft.trim() ? `${draft}\n${text}` : text;
    if (next.length > 500) return false;
    explore();
    setDraft(next);
    return true;
  }
  function interact(target: EventTarget) {
    if (target instanceof HTMLElement && !target.closest("[data-player-controls]")) explore();
  }
  const phrase = phase === 3 ? DEMO_BUDGET : DEMO_QUERY;
  const progress = Math.min(1, elapsed / (DEMO_PHASES[phase]?.duration || 1));
  const typing = phase === 0 || phase === 3;
  const typed = reducedMotion
    ? phrase
    : phrase.slice(0, Math.ceil(phrase.length * Math.min(1, progress * 1.4)));

  return (
    <section
      id="urunle-devam-et"
      data-demo-phase={phase}
      ref={root}
      className={styles.demo}
      aria-label="Etkileşimli sohbet tanıtımı"
    >
      <div className={styles.playerTop}>
        <p>Örnek sohbet</p>
        <span>Kalbi ve üç noktayı burada deneyebilirsin.</span>
      </div>
      <ChatProductToolsProvider
        key={replay}
        conversationId={`demo-${replay}`}
        backend={backend}
        busy={false}
        prepareMessage={prepareMessage}
        demoNotice={DEMO_NOTICE}
      >
        <div
          id="ornek-sohbet"
          className={styles.frame}
          onClickCapture={(event) => interact(event.target)}
          onFocusCapture={(event) => interact(event.target)}
        >
          <div className={styles.windowHeader}>
            <span>ManiCepte ile birlikte bakalım</span>
            <span className={styles.windowTag}>Tanıtım</span>
          </div>
          <DemoScene phase={phase} playing={playing} message={message} />
          <div className={styles.composer}>
            <ChatCompareTray />
            <ChatComposer
              draft={typing ? typed : draft}
              onDraftChange={setDraft}
              onSubmit={(event?: FormEvent) => {
                event?.preventDefault();
                if (!draft.trim()) return;
                explore();
                setMessage(draft.trim());
                setDraft("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (draft.trim()) {
                    explore();
                    setMessage(draft.trim());
                    setDraft("");
                  }
                }
              }}
              locked={phase === 1 || phase === 4}
            />
          </div>
        </div>
      </ChatProductToolsProvider>
      <div className={styles.playerBottom} data-player-controls>
        <p className={styles.sceneCaption}>{DEMO_PHASES[phase]?.caption}</p>
        <div className={styles.playerButtons}>
          <Button
            variant="ghost"
            onClick={() => (phase === DEMO_END ? restart() : setPlaying((value) => !value))}
          >
            {playing ? "Duraklat" : phase === DEMO_END ? "Yeniden oynat" : "Oynat"}
          </Button>
          {phase < DEMO_END ? (
            <Button variant="secondary" onClick={explore}>
              Kendin dene <span aria-hidden="true">↗</span>
            </Button>
          ) : null}
        </div>
      </div>
      <p className={styles.disclaimer}>
        {DEMO_NOTICE} Ürün görselleri örnektir; güncel fiyat ve stok gösterilmez.
      </p>
    </section>
  );
}

function DemoScene({
  phase,
  playing,
  message,
}: {
  phase: number;
  playing: boolean;
  message: string;
}) {
  const body = useRef<HTMLDivElement>(null);
  const savedOnce = useRef(false);
  const tools = useChatProductTools();
  useEffect(() => {
    if (phase === 6 && playing && tools?.account && !savedOnce.current && DEMO_CARDS[0]) {
      savedOnce.current = true;
      void tools.toggleSaved(DEMO_CARDS[0]);
    }
  }, [phase, playing, tools]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Yeni sahne veya mesaj geldiğinde yalnızca örnek pencerenin kaydırması güncellenir.
  useEffect(() => {
    if (body.current && !body.current.contains(document.activeElement))
      body.current.scrollTo({ top: body.current.scrollHeight, behavior: "instant" });
  }, [phase, message]);
  return (
    <div className={styles.viewport} ref={body}>
      <ol className={`${chat.thread} ${styles.thread}`} aria-label="Tanıtımdaki örnek konuşma">
        {phase === 0 ? (
          <li className={styles.welcome}>
            <Image
              src="/mascot/guide/robot-chat-head-v1.png"
              alt=""
              width={64}
              height={64}
              sizes="64px"
            />
            <p>
              Ne aradığını anlat.
              <br />
              <strong>Birlikte bakalım.</strong>
            </p>
          </li>
        ) : null}
        {phase >= 1 && phase < 4 ? <ChatUserRow text={DEMO_QUERY} /> : null}
        {phase === 1 ? (
          <li>
            <ChatPendingRow />
          </li>
        ) : null}
        {phase >= 2 && phase < 4 ? (
          <li className={chat.rowAssistant}>
            <p className={`${chat.bubble} ${chat.bubbleAssistant}`}>
              Günlük spor ayakkabı seçeneklerine birlikte bakalım. İstersen bütçeni de
              ekleyebilirsin.
            </p>
          </li>
        ) : null}
        {phase >= 4 && phase <= 5 ? <ChatUserRow text={DEMO_BUDGET} /> : null}
        {phase === 4 ? (
          <li>
            <ChatPendingRow label="Tercihine birlikte bakalım…" />
          </li>
        ) : null}
        {phase >= 5 ? (
          <li className={chat.rowAssistant}>
            <p className={`${chat.bubble} ${chat.bubbleAssistant}`}>
              {phase >= 6
                ? "Beğendiğini kaydet ya da üç noktadan devam et."
                : "Bütçeni aynı sohbete ekleyebilirsin. Beğendiğin ürünün kartından da devam edebilirsin."}
            </p>
          </li>
        ) : null}
        {message ? (
          <>
            <ChatUserRow text={message} />
            <li className={chat.rowAssistant}>
              <p className={`${chat.bubble} ${chat.bubbleAssistant}`}>
                Bu mesajı gerçek sohbette göndererek aramanı güncelleyebilirsin.
              </p>
            </li>
          </>
        ) : null}
      </ol>
      {phase >= 2 && phase !== 4 ? (
        <>
          <ChatIntentControls
            intent={demoIntent(phase >= 5)}
            chips={phase >= 6 ? [] : demoChips(phase >= 5)}
          />
          <ul className={styles.cards}>
            {DEMO_CARDS.map((product) => (
              <li key={product.productId}>
                <ProductCard
                  href="#ornek-sohbet"
                  title={product.title}
                  brand={product.brand}
                  imageUrl={product.imageUrl}
                  imageLoading="eager"
                  imageSizes="(min-width: 640px) 240px, 45vw"
                  minPrice={null}
                  priceLabel="Fiyat mağazada"
                  action={<ChatCardActions product={product} />}
                />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {phase === 7 ? (
        <div className={styles.featureCue}>
          <strong>Üç noktadan devam et</strong>
          <p>Fiyat alarmı kur · Benzerlerini bul · Karşılaştırmaya ekle</p>
        </div>
      ) : null}
    </div>
  );
}
