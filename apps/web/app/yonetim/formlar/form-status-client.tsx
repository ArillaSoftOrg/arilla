"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../admin.module.css";
import { setFormStatusAction } from "./actions.ts";

/** Yayınla / kapat / yeniden aç. Yayın, paylaşılan bağlantıyı hedef kitleye açar; onay ister. */
export function FormStatusClient({
  id,
  status,
}: {
  id: number;
  status: "draft" | "published" | "closed";
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function change(next: "published" | "closed") {
    const prompt =
      next === "published"
        ? "Form yayınlansın mı? Adres, hedef kitleye açılır."
        : "Form kapatılsın mı? Yeni yanıt alınmaz.";
    if (!window.confirm(prompt)) return;
    setPending(true);
    setMessage(null);
    try {
      const result = await setFormStatusAction(id, next);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      router.refresh();
    } catch {
      setMessage("İşlem yapılamadı. Tekrar dene.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.row}>
      {status === "published" ? (
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => void change("closed")}
        >
          Kapat
        </Button>
      ) : (
        <Button
          type="button"
          variant="primary"
          disabled={pending}
          onClick={() => void change("published")}
        >
          {status === "closed" ? "Yeniden aç" : "Yayınla"}
        </Button>
      )}
      {message ? (
        <p role="alert" className={styles.statusBad}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
