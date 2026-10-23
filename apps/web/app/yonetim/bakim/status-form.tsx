"use client";

import {
  MODES,
  type Mode,
  SERVICES,
  type Service,
  type SystemStatus,
} from "@arilla/core/maintenance";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveMaintenance } from "./actions.ts";
import styles from "./status-form.module.css";

const MODE_DETAILS: Record<Mode, { symbol: string; description: string }> = {
  normal: { symbol: "✓", description: "Tüm hizmetler açık, duyuru gösterilmez." },
  planned: { symbol: "◷", description: "Duyuru gösterilir, site kullanılmaya devam eder." },
  partial: { symbol: "◐", description: "Yalnızca seçtiğin hizmetler etkilenir." },
  maintenance: { symbol: "Ⅱ", description: "Kullanıcılar bakım ekranına yönlendirilir." },
};

function turkeyInput(iso: string | null): string {
  return iso ? new Date(Date.parse(iso) + 3 * 3600000).toISOString().slice(0, 16) : "";
}
export function MaintenanceForm({ initial }: { initial: SystemStatus }) {
  const router = useRouter();
  const [current, setCurrent] = useState(initial);
  const [mode, setMode] = useState<Mode>(initial.mode);
  const [message, setMessage] = useState(initial.message);
  const [eta, setEta] = useState(turkeyInput(initial.estimatedEnd));
  const [services, setServices] = useState<Service[]>(initial.services);
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const [reauth, setReauth] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (
          mode === "maintenance" &&
          !window.confirm("Tam bakım tüm kullanıcı erişimini durduracak. Yayınlansın mı?")
        )
          return;
        startTransition(async () => {
          setFeedback("");
          setReauth(undefined);
          try {
            const result = await saveMaintenance({
              status: {
                ...current,
                mode,
                message,
                estimatedEnd: eta ? new Date(`${eta}:00+03:00`).toISOString() : null,
                services,
              },
              reason,
            });
            if (!result.ok) {
              setFeedback(result.message);
              setReauth(result.reauthHref);
              return;
            }
            setCurrent(result.status);
            setMessage(result.status.message);
            setEta(turkeyInput(result.status.estimatedEnd));
            setServices(result.status.services);
            setReason("");
            setFeedback("Sistem durumu yayınlandı.");
            router.refresh();
          } catch {
            setFeedback(
              "Kayıt sonucu doğrulanamadı. Sayfayı yenileyip yayınlanan durumu kontrol et.",
            );
          }
        });
      }}
    >
      <div className={styles.published} data-mode={current.mode}>
        <span className={styles.statusSymbol} aria-hidden="true">
          {MODE_DETAILS[current.mode].symbol}
        </span>
        <div>
          <span className={styles.eyebrow}>Şu anda yayında</span>
          <strong>{MODES[current.mode]}</strong>
        </div>
        <span className={styles.version}>Sürüm {current.version}</span>
      </div>
      <fieldset className={styles.editor} disabled={pending}>
        <legend className={styles.srOnly}>Sistem durumunu düzenle</legend>
        <div className={styles.workspace}>
          <div className={styles.fields}>
            <fieldset className={styles.modeGroup}>
              <legend className={styles.sectionTitle}>Çalışma modu</legend>
              <p className={styles.hint}>Kullanıcıların karşılaşacağı deneyimi seç.</p>
              <div className={styles.modeGrid}>
                {(Object.entries(MODES) as [Mode, string][]).map(([key, label]) => (
                  <label className={styles.modeCard} data-mode={key} key={key}>
                    <input
                      type="radio"
                      name="maintenance-mode"
                      value={key}
                      checked={mode === key}
                      onChange={() => setMode(key)}
                    />
                    <span className={styles.modeIcon} aria-hidden="true">
                      {MODE_DETAILS[key].symbol}
                    </span>
                    <strong>{label}</strong>
                    <span>{MODE_DETAILS[key].description}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className={styles.block}>
              <h2 className={styles.sectionTitle}>Duyuru içeriği</h2>
              <label className={styles.field}>
                <span>Kullanıcıya gösterilecek mesaj</span>
                <textarea
                  rows={4}
                  maxLength={1500}
                  required={mode !== "normal"}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Neler oluyor? Kullanıcıların bilmesi gerekenleri kısaca yaz."
                />
                <span className={styles.counter}>{message.length} / 1500</span>
              </label>
              <label className={styles.field}>
                <span>
                  Tahmini bitiş <span className={styles.optional}>· İsteğe bağlı</span>
                </span>
                <input
                  type="datetime-local"
                  value={eta}
                  onChange={(e) => setEta(e.target.value)}
                  aria-describedby="eta-hint"
                />
              </label>
              <p className={styles.hint} id="eta-hint">
                Türkiye saati. Bu saat bilgilendirme içindir; bakım otomatik kapanmaz.
              </p>
            </div>
            <fieldset className={styles.serviceGroup}>
              <legend className={styles.sectionTitle}>Etkilenen hizmetler</legend>
              <p className={styles.hint}>Duyuruda belirtmek istediğin hizmetleri işaretle.</p>
              <div className={styles.serviceGrid}>
                {(Object.entries(SERVICES) as [Service, string][]).map(([key, label]) => (
                  <label className={styles.check} key={key}>
                    <input
                      type="checkbox"
                      checked={services.includes(key)}
                      onChange={(e) =>
                        setServices(
                          e.target.checked ? [...services, key] : services.filter((s) => s !== key),
                        )
                      }
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          <aside className={styles.previewColumn}>
            <div className={styles.previewHeading}>
              <span className={styles.eyebrow}>Kullanıcı görünümü</span>
              <span className={styles.previewTag}>Önizleme</span>
            </div>
            <section className={styles.previewCard} data-mode={mode} aria-label="Mesaj önizlemesi">
              <span className={styles.previewBrand}>
                ManiCepte <span>· Sistem durumu</span>
              </span>
              <span className={styles.previewSymbol} aria-hidden="true">
                {MODE_DETAILS[mode].symbol}
              </span>
              <h2>{MODES[mode]}</h2>
              <p className={styles.preview}>
                {mode === "normal"
                  ? "Tüm hizmetler normal çalışıyor. Kullanıcılara duyuru gösterilmez."
                  : message || "Mesajın burada görünecek."}
              </p>
              {mode !== "normal" && services.length > 0 && (
                <div className={styles.chips}>
                  {services.map((s) => (
                    <span key={s}>{SERVICES[s]}</span>
                  ))}
                </div>
              )}
              {mode !== "normal" && eta && (
                <div className={styles.previewEta}>
                  <span>Tahmini bitiş</span>
                  <strong>
                    {new Date(`${eta}:00+03:00`).toLocaleString("tr-TR", {
                      timeZone: "Europe/Istanbul",
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </strong>
                </div>
              )}
            </section>
            <p className={styles.previewNote}>
              {MODE_DETAILS[mode].description} Değişiklikler yalnızca yayınladığında uygulanır.
            </p>
          </aside>
        </div>
        <div className={styles.publishBar}>
          <label className={styles.field}>
            <span>İşlem gerekçesi</span>
            <input
              required
              minLength={5}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Örn. Planlı sürüm güncellemesi"
              aria-describedby="reason-hint"
            />
            <span className={styles.hint} id="reason-hint">
              Ekip için işlem geçmişine kaydedilir.
            </span>
          </label>
          <button className={styles.publishButton} type="submit" disabled={pending}>
            {pending ? "Yayınlanıyor…" : "Durumu yayınla"}
            <span aria-hidden="true">↗</span>
          </button>
        </div>
      </fieldset>
      <div role="status" aria-live="polite" className={feedback ? styles.feedback : undefined}>
        {feedback}
        {reauth && (
          <>
            {" "}
            <a href={reauth}>Yeniden giriş yap</a>
          </>
        )}
      </div>
    </form>
  );
}
