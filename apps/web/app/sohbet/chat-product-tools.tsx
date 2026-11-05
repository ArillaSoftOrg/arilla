"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ChatProductToolsContext, type ChatToolPanel } from "./chat-product-context.tsx";
import {
  CHAT_TOOL_ERRORS,
  type ChatToolAccount,
  type ChatToolBackend,
  type ChatToolProduct,
} from "./chat-product-model.ts";
import { ChatProductPanels } from "./chat-product-panels.tsx";
import styles from "./chat-product-tools.module.css";

export function ChatProductToolsProvider({
  conversationId,
  backend,
  busy,
  prepareMessage,
  demoNotice,
  children,
}: {
  conversationId: string;
  backend: ChatToolBackend;
  busy: boolean;
  prepareMessage: (text: string) => boolean;
  demoNotice?: string;
  children: ReactNode;
}) {
  const [account, setAccount] = useState<ChatToolAccount | null>(null);
  const [accountError, setAccountError] = useState(false);
  const [pendingSaves, setPendingSaves] = useState<number[]>([]);
  const pendingRef = useRef(new Set<number>());
  const accountVersion = useRef(0);
  const [selected, setSelected] = useState<ChatToolProduct[]>([]);
  const [panel, setPanel] = useState<ChatToolPanel | null>(null);
  const [message, setMessage] = useState("");
  const mounted = useRef(true);
  const accountRequest = useRef(0);

  const refreshAccount = useCallback(async () => {
    const version = accountVersion.current;
    const request = ++accountRequest.current;
    try {
      const result = await backend.account();
      if (
        !mounted.current ||
        request !== accountRequest.current ||
        version !== accountVersion.current
      )
        return;
      if (result.status === "ok") {
        setAccount(result.account);
        setAccountError(false);
      } else setAccountError(true);
    } catch {
      if (mounted.current && request === accountRequest.current) setAccountError(true);
    }
  }, [backend]);

  useEffect(() => {
    mounted.current = true;
    setAccount(null);
    setAccountError(false);
    setSelected([]);
    setPanel(null);
    setMessage("");
    void refreshAccount();
    return () => {
      mounted.current = false;
      accountRequest.current += 1;
    };
  }, [refreshAccount]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 6500);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    const onFocus = () => {
      if (pendingRef.current.size === 0) void refreshAccount();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshAccount]);

  async function toggleSaved(product: ChatToolProduct) {
    if (!account || pendingRef.current.has(product.productId)) return;
    pendingRef.current.add(product.productId);
    setPendingSaves([...pendingRef.current]);
    const saved = !account.savedProductIds.includes(product.productId);
    try {
      const result = await backend.save(product.slug, saved);
      if (result.status !== "ok") {
        setMessage(CHAT_TOOL_ERRORS[result.status]);
        return;
      }
      accountVersion.current += 1;
      setAccount(
        (current) =>
          current && {
            ...current,
            savedProductIds: result.saved
              ? [...new Set([...current.savedProductIds, product.productId])]
              : current.savedProductIds.filter((id) => id !== product.productId),
          },
      );
      setMessage(result.saved ? "Ürün kaydedildi." : "Ürün kaydettiklerinden kaldırıldı.");
    } catch {
      setMessage(CHAT_TOOL_ERRORS.unavailable);
    } finally {
      pendingRef.current.delete(product.productId);
      setPendingSaves([...pendingRef.current]);
    }
  }

  async function setAlarm(product: ChatToolProduct, price: number | null): Promise<boolean> {
    try {
      const result = await backend.alarm(product.slug, price);
      if (result.status !== "ok") {
        setMessage(CHAT_TOOL_ERRORS[result.status]);
        return false;
      }
      accountVersion.current += 1;
      setAccount(
        (current) =>
          current && {
            ...current,
            alarms: [
              ...current.alarms.filter((item) => item.productId !== product.productId),
              ...(result.alarm ? [result.alarm] : []),
            ],
          },
      );
      setMessage(result.alarm ? "Fiyat alarmın aktif." : "Fiyat alarmı kaldırıldı.");
      return true;
    } catch {
      setMessage(CHAT_TOOL_ERRORS.unavailable);
      return false;
    }
  }

  function toggleCompare(product: ChatToolProduct) {
    if (selected.some((item) => item.productId === product.productId)) {
      const next = selected.filter((item) => item.productId !== product.productId);
      setSelected(next);
      if (panel?.kind === "compare" && next.length < 2) setPanel(null);
      return;
    }
    if (selected.length === 3) {
      setMessage("En fazla 3 ürün karşılaştırabilirsin. Önce birini kaldır.");
      return;
    }
    setSelected([...selected, product]);
    setMessage(`${selected.length + 1} ürün karşılaştırma için seçildi.`);
  }

  function prepare(text: string) {
    if (busy || !prepareMessage(text)) {
      setMessage(
        busy
          ? "Yanıt tamamlandıktan sonra devam edebilirsin."
          : "Mesaj kutusunda yeterli yer yok. Yazdığın mesajı kısaltıp tekrar deneyebilirsin.",
      );
      return false;
    }
    setMessage(
      demoNotice
        ? "Tercihin örnek mesaj kutusuna eklendi. Bu tanıtımda gerçek arama yapılmaz."
        : "Tercihin mesaj kutusuna eklendi. Gönderdiğinde araman güncellenecek.",
    );
    return true;
  }

  const content = (
    <>
      {children}
      <p className={styles.notice} role="status" data-demo-notice={demoNotice ? "true" : undefined}>
        {message ? `${demoNotice ? "Örnekte: " : ""}${message}` : ""}
      </p>
      <ChatProductPanels />
    </>
  );

  return (
    <ChatProductToolsContext.Provider
      key={conversationId}
      value={{
        demoNotice,
        backend,
        account,
        accountError,
        refreshAccount,
        pendingSaves,
        toggleSaved,
        setAlarm,
        selected,
        toggleCompare,
        clearComparison: () => setSelected([]),
        panel,
        openPanel: setPanel,
        closePanel: () => setPanel(null),
        busy,
        prepareMessage: prepare,
      }}
    >
      {demoNotice ? (
        <div
          onClickCapture={(event) => {
            if (event.target instanceof Element && event.target.closest('a[href^="/urun/"]')) {
              event.preventDefault();
              setPanel(null);
              setMessage(
                "Ürün sayfası bu tanıtımda açılmaz. Kart işlemlerini burada deneyebilirsin.",
              );
            }
          }}
        >
          {content}
        </div>
      ) : (
        content
      )}
    </ChatProductToolsContext.Provider>
  );
}
