"use client";

import {
  bypassMaintenance,
  MODES,
  parseStatus,
  SERVICES,
  type SystemStatus,
} from "@arilla/core/maintenance";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import styles from "./system-status.module.css";

export function SystemStatusClient() {
  const path = usePathname();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (bypassMaintenance(path)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const check = async () => {
      try {
        const response = await fetch(`/api/system-status?path=${encodeURIComponent(path)}`, {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) throw new Error();
        const raw = await response.json();
        const next = parseStatus(raw);
        if (stopped) return;
        setStatus(next);
        setUnavailable(false);
        if (raw.blocked === true) {
          window.location.replace(`/durum?next=${encodeURIComponent(path)}`);
          return;
        }
      } catch {
        if (!stopped) setUnavailable(true);
      }
      if (!stopped) timer = setTimeout(check, 15000);
    };
    void check();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [path]);
  if (bypassMaintenance(path)) return null;
  if (unavailable)
    return (
      <aside className={styles.banner} role="status">
        Sistem durumu doğrulanamıyor. Bağlantı yeniden kontrol ediliyor.
      </aside>
    );
  if (!status || status.mode === "normal") return null;
  return (
    <aside className={styles.banner} role="status" aria-live="polite">
      <strong>{MODES[status.mode]}</strong>
      <p>{status.message}</p>
      {status.services.length > 0 && (
        <p>Etkilenen hizmetler: {status.services.map((s) => SERVICES[s]).join(", ")}</p>
      )}
      {status.estimatedEnd && (
        <p>
          Tahmini bitiş:{" "}
          {new Date(status.estimatedEnd).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}{" "}
          (Türkiye saati)
        </p>
      )}
      <a href="/durum">Sistem durumunu görüntüle</a>
    </aside>
  );
}
