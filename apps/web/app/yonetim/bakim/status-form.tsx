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
      <p>
        Yayınlanan mod: <strong>{MODES[current.mode]}</strong> · Sürüm {current.version}
      </p>
      <fieldset disabled={pending}>
        <label>
          Çalışma modu
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            {Object.entries(MODES).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kullanıcıya gösterilecek mesaj
          <textarea
            rows={4}
            maxLength={1500}
            required={mode !== "normal"}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        <label>
          Tahmini bitiş (Türkiye saati)
          <input type="datetime-local" value={eta} onChange={(e) => setEta(e.target.value)} />
        </label>
        <p>
          Bu saat yalnızca bilgilendirme içindir; bakım otomatik kapanmaz. Planlı bakım duyurusu
          uygulamayı kapatmaz.
        </p>
        <fieldset>
          <legend>Etkilenen hizmetler</legend>
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
              {label}
            </label>
          ))}
        </fieldset>
        <label>
          İşlem gerekçesi
          <input
            required
            minLength={5}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Yayınlanıyor…" : "Durumu yayınla"}
        </button>
      </fieldset>
      <p role="status" aria-live="polite">
        {feedback}
      </p>
      {reauth && <a href={reauth}>Yeniden giriş yap</a>}
      <section aria-label="Mesaj önizlemesi">
        <h2>{MODES[mode]}</h2>
        <p className={styles.preview}>{message || "Mesaj önizlemesi burada görünecek."}</p>
        {services.length > 0 && <p>{services.map((s) => SERVICES[s]).join(", ")}</p>}
      </section>
    </form>
  );
}
