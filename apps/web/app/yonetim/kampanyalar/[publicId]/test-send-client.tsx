"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../../admin.module.css";
import { sendTestAction } from "../actions.ts";

/**
 * Tek bir test adresine "Test:" önekli ileti. Kampanya alıcısı sayılmaz,
 * sayaçları değiştirmez; adres denetim kaydına yazılmaz. Yerelde Mailpit'e
 * düşer. Hız sınırı ve doğrulama sunucuda.
 */
export function TestSendClient({
  publicId,
  contentVersion,
  defaultRecipient,
}: {
  publicId: string;
  contentVersion: number;
  defaultRecipient: string;
}) {
  const router = useRouter();
  const [recipient, setRecipient] = useState(defaultRecipient);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  async function submit() {
    setPending(true);
    setMessage(null);
    try {
      const result = await sendTestAction({
        publicId,
        expectedContentVersion: contentVersion,
        recipient,
      });
      if (!result.ok) {
        setMessage({ text: result.message, error: true });
        return;
      }
      setMessage({
        text: "Test e-postası gönderildi. Gelen kutusunda (yerelde Mailpit) incele.",
        error: false,
      });
      router.refresh();
    } catch {
      setMessage({ text: "Gönderilemedi. Tekrar dene.", error: true });
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
        <span className={styles.meta}>Test alıcısı</span>
        <input
          type="email"
          required
          maxLength={254}
          autoComplete="off"
          className={styles.textInput}
          value={recipient}
          onChange={(event) => setRecipient(event.target.value)}
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
        <Button type="submit" variant="secondary" disabled={pending}>
          Test e-postası gönder
        </Button>
      </div>
    </form>
  );
}
