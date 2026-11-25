"use client";

import { useState } from "react";

const SCHEDULE_API = "/api/yonetim/katalog-toplama/zamanlama";

const ERROR_TEXT: Record<string, string> = {
  fresh_login_required: "Zamanlamayı değiştirmek için yeniden giriş yapın.",
  schedule_flag_off: "TRENDYOL_SCHEDULE_ENABLED kapalı; zamanlama açılamaz.",
  no_targets: "Açmak için en az bir geçerli Trendyol ürün ya da liste adresi gerekir.",
  bad_pace: "Hız 20 ile 600 saniye arasında olmalı.",
};

/**
 * Zamanlanmış toplama ayarı (karar 0221): hedef adresler, hız, açık/kapalı. Kota bu formdan
 * değişmez; sunucu her koşuda kotayı yeniden sorar.
 */
export function ScheduleForm({
  enabled,
  targetUrls,
  paceSeconds,
  flagEnabled,
}: {
  enabled: boolean;
  targetUrls: string[];
  paceSeconds: number;
  flagEnabled: boolean;
}) {
  const [on, setOn] = useState(enabled);
  const [text, setText] = useState(targetUrls.join("\n"));
  const [pace, setPace] = useState(paceSeconds);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(SCHEDULE_API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "save",
          source: "trendyol",
          enabled: on,
          targetUrls: text,
          paceSeconds: pace,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(ERROR_TEXT[String(data.error)] ?? `Kaydedilemedi: ${data.error ?? res.status}`);
        return;
      }
      setMessage(
        `Kaydedildi: ${data.saved} adres${data.invalid ? `, ${data.invalid} geçersiz adres atıldı` : ""}${
          data.overflow ? `, ${data.overflow} adres sınırı aştı` : ""
        }.`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label>
        <input
          type="checkbox"
          checked={on}
          disabled={!flagEnabled && !on}
          onChange={(e) => setOn(e.target.checked)}
        />{" "}
        Zamanlanmış toplama açık
      </label>
      <label style={{ display: "block", marginTop: 8 }}>
        Hedef adresler (satır başına bir Trendyol ürün ya da liste adresi, en çok 500)
        <textarea
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ width: "100%", fontFamily: "inherit" }}
        />
      </label>
      <label style={{ display: "block", marginTop: 8 }}>
        İki sayfa arası en az bekleme (saniye, 20-600; üstüne rastgele %0-50 eklenir){" "}
        <input
          type="number"
          min={20}
          max={600}
          value={pace}
          onChange={(e) => setPace(Number(e.target.value))}
        />
      </label>
      <p>
        <button type="button" disabled={busy} onClick={save}>
          Zamanlamayı kaydet
        </button>
      </p>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
