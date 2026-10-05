"use client";

import { Button } from "@arilla/ui";
import { useId, useState, useTransition } from "react";
import { completeOnboardingAction } from "./actions.ts";
import styles from "./page.module.css";

const STEP_COUNT = 2;

/**
 * Karşılama akışı. Adım 1 bilgilendirme (varsayılan açık iki izni açıkça
 * söyler), adım 2 (SON adım) haftalık özet. Bülten kartı varsayılan KAPALI;
 * yalnızca kullanıcı açarsa `true` gider. Devam (dokunmadan) ve Atla her
 * adımda `false` ile akışı bitirir; Geri önceki adıma döner.
 */
export function OnboardingClient({ email, next }: { email: string | null; next: string }) {
  const [step, setStep] = useState(0);
  const [newsletter, setNewsletter] = useState(false);
  const [pending, startTransition] = useTransition();
  const switchId = useId();

  function finish(optIn: boolean) {
    startTransition(async () => {
      await completeOnboardingAction({ newsletter: optIn, next });
    });
  }

  const isLast = step === STEP_COUNT - 1;

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="hos-geldin-baslik">
        <p className={styles.progress} aria-live="polite">
          Adım {step + 1} / {STEP_COUNT}
        </p>

        {step === 0 ? (
          <>
            <h1 id="hos-geldin-baslik" className={styles.title}>
              ManiCepte'ye hoş geldin.
            </h1>
            <p className={styles.text}>
              Fotoğraf, ürün bağlantısı ya da kısa bir tarifle ara; aynı ve benzer ürünleri
              mağazalar arasında karşılaştır.
            </p>
            <p className={styles.text}>
              Daha isabetli öneriler için gezindiğin ürünler kişiselleştirmede kullanılır ve
              bulduğların kimliğin görünmeden keşfet akışına katkı olarak girebilir. Bu iki tercih
              yeni hesaplarda açık başlar; gizlilik ve KVKK sayfalarından nasıl işlendiğini
              okuyabilirsin.
            </p>
          </>
        ) : (
          <>
            <h1 id="hos-geldin-baslik" className={styles.title}>
              Gelişmelerden haberdar ol.
            </h1>
            <p className={styles.text}>
              Haftalık ManiCepte fırsatlarını, önemli ürün güncellemelerini ve yeni özellik
              haberlerini e-postanla alabilirsin. İstediğin zaman abonelikten çıkabilirsin.
            </p>
            <p className={styles.email}>
              {email ? (
                <>
                  <span className={styles.emailLabel}>E-posta</span>
                  <span className={styles.emailValue}>{email}</span>
                </>
              ) : (
                <span className={styles.emailLabel}>
                  Hesabında e-posta adresi yok; haftalık özet gönderilemez.
                </span>
              )}
            </p>
            <label
              htmlFor={switchId}
              className={`${styles.optIn} ${newsletter ? styles.optInOn : ""}`}
            >
              <span className={styles.optInText}>
                Haftalık fırsat özetini bana e-posta ile gönder.
              </span>
              <input
                id={switchId}
                className={styles.optInInput}
                type="checkbox"
                role="switch"
                aria-checked={newsletter}
                checked={newsletter}
                disabled={!email || pending}
                onChange={(event) => setNewsletter(event.target.checked)}
              />
            </label>
          </>
        )}

        <div className={styles.actions}>
          {step > 0 ? (
            <Button
              type="button"
              variant="ghost"
              shape="pill"
              disabled={pending}
              onClick={() => setStep(step - 1)}
            >
              Geri
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            shape="pill"
            disabled={pending}
            onClick={() => finish(false)}
          >
            Atla
          </Button>
          <Button
            type="button"
            variant="accent"
            shape="pill"
            disabled={pending}
            onClick={() => (isLast ? finish(newsletter) : setStep(step + 1))}
          >
            Devam
          </Button>
        </div>
      </section>
    </main>
  );
}
