"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../admin.module.css";
import { createCampaignAction, updateCampaignAction } from "./actions.ts";

/**
 * Taslak oluşturma ve düzenleme. Gövde düz metindir: boş satır paragraf,
 * `https://` adresi bağlantı olur, HTML yazılamaz (core'da kaçırılır).
 * Sınırlar ve asıl doğrulama core'da (`validateCampaignContent`).
 */
export function CampaignFormClient(
  props:
    | { mode: "create" }
    | {
        mode: "edit";
        publicId: string;
        contentVersion: number;
        title: string;
        subject: string;
        body: string;
      },
) {
  const router = useRouter();
  const editing = props.mode === "edit";
  const [title, setTitle] = useState(editing ? props.title : "");
  const [subject, setSubject] = useState(editing ? props.subject : "");
  const [body, setBody] = useState(editing ? props.body : "");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  async function submit() {
    setPending(true);
    setMessage(null);
    try {
      if (props.mode === "create") {
        const result = await createCampaignAction({ title, subject, body });
        if (!result.ok) {
          setMessage({ text: result.message, error: true });
          return;
        }
        router.push(`/yonetim/kampanyalar/${result.publicId}`);
        return;
      }
      const result = await updateCampaignAction({
        publicId: props.publicId,
        expectedContentVersion: props.contentVersion,
        title,
        subject,
        body,
      });
      if (!result.ok) {
        setMessage({ text: result.message, error: true });
        return;
      }
      setMessage({
        text: result.changed
          ? "Taslak kaydedildi. İçerik değiştiyse gerçek gönderimden önce yeniden test gönder."
          : "Değişiklik yok.",
        error: false,
      });
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
        <span className={styles.meta}>İç ad (yalnızca yönetimde görünür)</span>
        <input
          required
          maxLength={120}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        <span className={styles.meta}>Konu</span>
        <input
          required
          maxLength={150}
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
      </label>
      <label>
        <span className={styles.meta}>
          İçerik (düz metin; boş satır paragraf, https:// adresleri bağlantı olur)
        </span>
        <textarea
          required
          maxLength={10000}
          className={styles.textArea}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      {message ? (
        <p
          role={message.error ? "alert" : "status"}
          className={message.error ? styles.statusBad : styles.muted}
        >
          {message.text}
        </p>
      ) : null}
      <div className={styles.row}>
        <Button type="submit" variant="primary" disabled={pending}>
          {editing ? "Taslağı kaydet" : "Taslak oluştur"}
        </Button>
      </div>
    </form>
  );
}
