"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../admin.module.css";
import { setTrackingLinkActiveAction } from "./actions.ts";

/** Bağlantıyı kopyala. Pano yoksa (eski tarayıcı, http) adres seçilebilir metin olarak kalır. */
export function CopyLinkButton({ url }: { url: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2500);
  }

  return (
    <span className={styles.row}>
      <Button type="button" variant="secondary" onClick={() => void copy()}>
        {state === "copied" ? "Kopyalandı" : "Bağlantıyı kopyala"}
      </Button>
      <span role="status" className={styles.meta}>
        {state === "failed" ? "Kopyalanamadı; adresi elle seç." : ""}
      </span>
    </span>
  );
}

/** Aç/kapat. Kapatılan bağlantı 404 verir; kapatma, önbelleği hemen geçersiz kılar. */
export function ToggleActiveButton({ id, active }: { id: number; active: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; href?: string } | null>(null);

  async function toggle() {
    setPending(true);
    setMessage(null);
    try {
      const result = await setTrackingLinkActiveAction({ id, active: !active });
      if (!result.ok) {
        setMessage({ text: result.message, href: result.reauthHref });
        return;
      }
      router.refresh();
    } catch {
      setMessage({ text: "İşlem yapılamadı. Tekrar dene." });
    } finally {
      setPending(false);
    }
  }

  return (
    <span className={styles.row}>
      <Button type="button" variant="secondary" disabled={pending} onClick={() => void toggle()}>
        {active ? "Bağlantıyı kapat" : "Bağlantıyı aç"}
      </Button>
      {message ? (
        <span role="alert" className={styles.statusBad}>
          {message.text}
          {message.href ? (
            <>
              {" "}
              <a href={message.href}>Yeniden giriş yap</a>
            </>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
