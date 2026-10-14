"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../admin.module.css";
import { createTrackingLinkAction, updateTrackingLinkAction } from "./actions.ts";

/**
 * Oluşturma ve düzenleme. Slug oluşturulduktan sonra değişmez (paylaşılmış
 * bağlantı kırılmasın). Asıl doğrulama core'da (`policy.ts`); buradaki
 * `maxLength`/`pattern` yalnızca erken geri bildirimdir.
 */
export function LinkFormClient(
  props:
    | { mode: "create"; origin: string }
    | {
        mode: "edit";
        id: number;
        expectedUpdatedAt: string;
        slug: string;
        origin: string;
        name: string;
        targetUrl: string;
        source: string;
        campaign: string;
      },
) {
  const router = useRouter();
  const editing = props.mode === "edit";
  const [name, setName] = useState(editing ? props.name : "");
  const [slug, setSlug] = useState(editing ? props.slug : "");
  const [targetUrl, setTargetUrl] = useState(editing ? props.targetUrl : "/");
  const [source, setSource] = useState(editing ? props.source : "");
  const [campaign, setCampaign] = useState(editing ? props.campaign : "");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean; href?: string } | null>(
    null,
  );

  async function submit() {
    setPending(true);
    setMessage(null);
    try {
      const result =
        props.mode === "create"
          ? await createTrackingLinkAction({ name, slug, targetUrl, source, campaign })
          : await updateTrackingLinkAction({
              id: props.id,
              expectedUpdatedAt: props.expectedUpdatedAt,
              name,
              targetUrl,
              source,
              campaign,
            });
      if (!result.ok) {
        setMessage({ text: result.message, error: true, href: result.reauthHref });
        return;
      }
      if (props.mode === "create" && result.id) {
        router.push(`/yonetim/takip-baglantilari/${result.id}`);
        return;
      }
      setMessage({ text: result.changed ? "Kaydedildi." : "Değişiklik yok.", error: false });
      router.refresh();
    } catch {
      setMessage({ text: "Kaydedilemedi. Tekrar dene.", error: true });
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className={styles.formGrid}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label>
        <span className={styles.meta}>Ad (yalnızca yönetimde görünür)</span>
        <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        <span className={styles.meta}>
          {`Slug (${props.origin.replace(/^https?:\/\//, "")}/…; küçük harf, rakam, tire${editing ? "; sonradan değişmez" : ""})`}
        </span>
        <input
          required
          readOnly={editing}
          maxLength={40}
          pattern="[a-z0-9]([a-z0-9\-]{0,38}[a-z0-9])?"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
        />
      </label>
      <label>
        <span className={styles.meta}>
          Hedef (/ ile başlayan site yolu ya da ManiCepte alan adında https adresi)
        </span>
        <input
          required
          maxLength={2000}
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
          value={targetUrl}
          onChange={(e) => setTargetUrl(e.target.value)}
        />
      </label>
      <label>
        <span className={styles.meta}>Kaynak (utm_source; örn. instagram, isteğe bağlı)</span>
        <input
          maxLength={40}
          autoCapitalize="none"
          spellCheck={false}
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
      </label>
      <label>
        <span className={styles.meta}>Kampanya (utm_campaign; örn. yaz-26, isteğe bağlı)</span>
        <input
          maxLength={40}
          autoCapitalize="none"
          spellCheck={false}
          value={campaign}
          onChange={(e) => setCampaign(e.target.value)}
        />
      </label>
      {message ? (
        <p
          role={message.error ? "alert" : "status"}
          className={message.error ? styles.statusBad : styles.muted}
        >
          {message.text}
          {message.href ? (
            <>
              {" "}
              <a href={message.href}>Yeniden giriş yap</a>
            </>
          ) : null}
        </p>
      ) : null}
      <div className={styles.row}>
        <Button type="submit" variant="primary" disabled={pending}>
          {editing ? "Değişiklikleri kaydet" : "Bağlantı oluştur"}
        </Button>
      </div>
    </form>
  );
}
