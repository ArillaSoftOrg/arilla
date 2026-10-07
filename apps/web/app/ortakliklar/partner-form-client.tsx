"use client";

import { type FormEvent, useState } from "react";
import styles from "./page.module.css";

/**
 * Yalnizca arayuz: veri hicbir yere gonderilmez, saklanmaz. Gonder'e basinca
 * yerel bir bilgi durumu gosterilir.
 */
export function PartnerFormClient() {
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className={styles.formCard} role="status">
        <h3 className={styles.h3}>Teşekkürler.</h3>
        <p className={styles.bodyText}>
          Başvuru formu şu an yalnızca bir önizlemedir; bilgileriniz gönderilmedi ve kaydedilmedi.
          Program açıldığında bu form üzerinden başvurabileceksiniz.
        </p>
      </div>
    );
  }

  return (
    <form className={styles.formCard} onSubmit={handleSubmit}>
      <div className={styles.field}>
        <label htmlFor="pf-brand">Marka adı *</label>
        <input
          id="pf-brand"
          name="brand"
          required
          autoComplete="organization"
          placeholder="Örnek Mağaza"
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="pf-contact">İletişim adı *</label>
        <input
          id="pf-contact"
          name="contact"
          required
          autoComplete="name"
          placeholder="Ayşe Yılmaz"
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="pf-email">İş e-postası *</label>
        <input
          id="pf-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="ayse@marka.com"
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="pf-network">Ortaklık ağı *</label>
        <select id="pf-network" name="network" required defaultValue="">
          <option value="" disabled>
            Bir ağ seçin
          </option>
          <option value="affiliate">Affiliate ağı</option>
          <option value="feed">Doğrudan ürün akışı</option>
          <option value="other">Diğer</option>
        </select>
      </div>
      <div className={styles.field}>
        <label htmlFor="pf-network-id">Ağ kimliği *</label>
        <input id="pf-network-id" name="networkId" required placeholder="örneğin 12345" />
      </div>

      <fieldset className={styles.radios}>
        <legend>Güncel ve canlı bir ürün akışına sahip misiniz?</legend>
        <label>
          <input type="radio" name="feed" value="yes" /> Evet
        </label>
        <label>
          <input type="radio" name="feed" value="no" /> Hayır
        </label>
        <label>
          <input type="radio" name="feed" value="unsure" /> Emin değilim
        </label>
      </fieldset>

      <hr className={styles.rule} />

      <div className={styles.field}>
        <label htmlFor="pf-cr">Ortalama dönüşüm oranı</label>
        <input id="pf-cr" name="conversionRate" inputMode="decimal" placeholder="%2,4" />
      </div>
      <div className={styles.field}>
        <label htmlFor="pf-aov">Ortalama sipariş değeri</label>
        <input id="pf-aov" name="averageOrder" inputMode="decimal" placeholder="1.800 TL" />
      </div>
      <div className={styles.field}>
        <label htmlFor="pf-cpa">Temel komisyon oranı</label>
        <input id="pf-cpa" name="baseCommission" inputMode="decimal" placeholder="%8" />
      </div>

      <hr className={styles.rule} />

      <button type="submit" className={styles.cta}>
        Ortak olun <span aria-hidden="true">→</span>
      </button>
    </form>
  );
}
