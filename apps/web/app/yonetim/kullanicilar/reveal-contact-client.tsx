"use client";

import type { ContactField } from "@arilla/core";
import { Button } from "@arilla/ui";
import Link from "next/link";
import { useState, useTransition } from "react";
import styles from "../admin.module.css";
import { type RevealState, revealContactAction } from "./actions.ts";

/**
 * Tıkla-göster (karar 0049 §2). Sayfa yalnızca maskeli değeri taşır; tam
 * değer düğmeye basınca server action'dan gelir ve YALNIZCA bu bileşenin
 * durumunda kalır (adres satırı, `localStorage`, önbellek yok). "Gizle" ya
 * da sayfa yenileme değeri unutturur.
 */
export function RevealContactClient({
  publicId,
  field,
  masked,
}: {
  publicId: string;
  field: ContactField;
  masked: string;
}) {
  const [state, setState] = useState<RevealState | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const label = field === "email" ? "e-postayı" : "telefonu";

  function reveal() {
    setFailed(false);
    startTransition(async () => {
      try {
        setState(await revealContactAction(publicId, field));
      } catch {
        setFailed(true);
      }
    });
  }

  if (state?.status === "ok") {
    return (
      <span className={styles.reveal}>
        <span className={styles.mono}>{state.value ?? "Kayıtlı değer yok"}</span>
        <Button type="button" variant="ghost" onClick={() => setState(null)}>
          Gizle
        </Button>
      </span>
    );
  }

  return (
    <span className={styles.reveal}>
      <span>{masked}</span>
      <Button
        type="button"
        variant="ghost"
        onClick={reveal}
        disabled={pending}
        aria-label={`Tam ${label} göster`}
      >
        {pending ? "Gösteriliyor…" : "Göster"}
      </Button>
      {state?.status === "reauth" ? (
        <span className={styles.statusWarn} role="alert">
          Bu bilgi için yakın zamanda giriş yapmış olman gerekiyor.{" "}
          <Link href={state.href}>Yeniden giriş yap</Link>
        </span>
      ) : null}
      {state?.status === "not_found" ? (
        <span className={styles.statusBad} role="alert">
          Hesap bulunamadı.
        </span>
      ) : null}
      {failed ? (
        <span className={styles.statusBad} role="alert">
          Gösterilemedi. Tekrar dene.
        </span>
      ) : null}
    </span>
  );
}
