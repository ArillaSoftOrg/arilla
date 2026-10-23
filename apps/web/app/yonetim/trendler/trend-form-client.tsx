"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import styles from "../admin.module.css";
import { createTrendAction, updateTrendDetailsAction } from "./actions.ts";

/** Sunucudan gelen ayrıntılar (tarih ISO metin). */
export interface TrendDetailsView {
  title: string;
  description: string;
  category: string;
  trendType: string;
  heroImageUrl: string | null;
  activeFrom: string | null;
  activeUntil: string | null;
}

const CATEGORY_OPTIONS = [
  ["moda", "Moda"],
  ["guzellik", "Güzellik"],
  ["ev-yasam", "Ev & Yaşam"],
  ["ogrenci", "Öğrenci"],
  ["genel", "Genel"],
] as const;

const TYPE_OPTIONS = [
  ["evergreen", "Kalıcı"],
  ["seasonal", "Sezonluk"],
  ["campaign", "Kampanya"],
] as const;

/** Başlıktan adres önerisi; core `suggestTrendSlug` ile aynı kural (kayıtta core yeniden doğrular). */
const FOLD: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  İ: "i",
  I: "i",
  ö: "o",
  ş: "s",
  ü: "u",
  â: "a",
  î: "i",
  û: "u",
};
function suggestSlug(title: string): string {
  return [...title]
    .map((ch) => FOLD[ch] ?? ch.toLowerCase())
    .join("")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

/** ISO → `datetime-local` değeri (tarayıcı saat diliminde). */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Dokunulmamış alan özgün ISO değerini korur (milisaniye kaybı yanlış "değişti" üretmesin). */
function fromLocalInput(value: string, original: string | null): string | null {
  if (!value) return null;
  if (original && toLocalInput(original) === value) return original;
  return new Date(value).toISOString();
}

/**
 * Koleksiyon ayrıntıları: oluşturma ve düzenleme. Adres yalnızca oluştururken seçilir,
 * sonra değişmez. Asıl doğrulama core'da (`parseTrendDetails`); buradaki sınırlar erken
 * geri bildirimdir. Düzenlemede formun açıldığı andaki değerler `expected` olarak gider:
 * arada başka biri değiştirdiyse kayıt reddedilir.
 */
export function TrendFormClient(
  props:
    | { mode: "create" }
    | { mode: "edit"; trendId: number; slug: string; initial: TrendDetailsView },
) {
  const router = useRouter();
  const ids = { reason: useId(), description: useId() };
  const initial: TrendDetailsView =
    props.mode === "edit"
      ? props.initial
      : {
          title: "",
          description: "",
          category: "guzellik",
          trendType: "seasonal",
          heroImageUrl: null,
          activeFrom: null,
          activeUntil: null,
        };
  const [title, setTitle] = useState(initial.title);
  const [slug, setSlug] = useState(props.mode === "edit" ? props.slug : "");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState(initial.description);
  const [category, setCategory] = useState(initial.category);
  const [trendType, setTrendType] = useState(initial.trendType);
  const [heroImageUrl, setHeroImageUrl] = useState(initial.heroImageUrl ?? "");
  const [activeFrom, setActiveFrom] = useState(toLocalInput(initial.activeFrom));
  const [activeUntil, setActiveUntil] = useState(toLocalInput(initial.activeUntil));
  const [curation, setCuration] = useState<"manual" | "auto">("manual");
  const [featured, setFeatured] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean; href?: string } | null>(
    null,
  );

  async function submit() {
    setPending(true);
    setMessage(null);
    const next = {
      title,
      description,
      category,
      trendType,
      heroImageUrl: heroImageUrl.trim() || null,
      activeFrom: fromLocalInput(activeFrom, initial.activeFrom),
      activeUntil: fromLocalInput(activeUntil, initial.activeUntil),
    };
    try {
      if (props.mode === "create") {
        const result = await createTrendAction({ slug, details: next, curation, featured, reason });
        if (!result.ok) {
          setMessage({ text: result.message, error: true, href: result.reauthHref });
          return;
        }
        if (result.trendId) router.push(`/yonetim/trendler/${result.trendId}`);
        return;
      }
      const result = await updateTrendDetailsAction({
        trendId: props.trendId,
        expected: { ...initial },
        next,
        reason,
      });
      if (!result.ok) {
        setMessage({ text: result.message, error: true, href: result.reauthHref });
        return;
      }
      setReason("");
      setMessage({ text: result.changed ? "Kaydedildi." : "Değişiklik yok.", error: false });
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
        <span className={styles.meta}>Başlık (en çok 120 karakter)</span>
        <input
          required
          maxLength={120}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            if (props.mode === "create" && !slugTouched) setSlug(suggestSlug(event.target.value));
          }}
        />
      </label>
      <label>
        <span className={styles.meta}>
          {props.mode === "create"
            ? "Adres (/trendler/…; küçük harf, rakam, tire; oluşturduktan sonra değişmez)"
            : "Adres (değişmez: yayınlanmış adres ölmesin)"}
        </span>
        <input
          required
          readOnly={props.mode === "edit"}
          maxLength={80}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={slug}
          onChange={(event) => {
            setSlugTouched(true);
            setSlug(event.target.value.toLowerCase());
          }}
        />
      </label>
      <label htmlFor={ids.description}>
        <span className={styles.meta}>{`Kısa açıklama (${description.length}/280)`}</span>
        <textarea
          id={ids.description}
          className={styles.textArea}
          required
          maxLength={280}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <div className={styles.row}>
        <label>
          <span className={styles.meta}>Kategori</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            {CATEGORY_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={styles.meta}>Sezon / tür</span>
          <select value={trendType} onChange={(event) => setTrendType(event.target.value)}>
            {TYPE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.row}>
        <label>
          <span className={styles.meta}>Yayın penceresi başlangıcı (isteğe bağlı)</span>
          <input
            type="datetime-local"
            value={activeFrom}
            onChange={(event) => setActiveFrom(event.target.value)}
          />
        </label>
        <label>
          <span className={styles.meta}>Yayın penceresi bitişi (isteğe bağlı)</span>
          <input
            type="datetime-local"
            value={activeUntil}
            onChange={(event) => setActiveUntil(event.target.value)}
          />
        </label>
      </div>
      <label>
        <span className={styles.meta}>
          Kapak görseli (isteğe bağlı https adresi; boşsa ilk ürünün görseli kullanılır)
        </span>
        <input
          inputMode="url"
          maxLength={2048}
          autoCapitalize="none"
          spellCheck={false}
          value={heroImageUrl}
          onChange={(event) => setHeroImageUrl(event.target.value)}
        />
      </label>
      {props.mode === "create" ? (
        <>
          <fieldset className={styles.formGrid}>
            <legend className={styles.filterLabel}>Koleksiyon türü</legend>
            <label className={styles.row}>
              <input
                type="radio"
                name="curation"
                checked={curation === "manual"}
                onChange={() => setCuration("manual")}
              />
              Elle seçilmiş: ürünleri editör seçer; otomatik küratör dokunmaz.
            </label>
            <label className={styles.row}>
              <input
                type="radio"
                name="curation"
                checked={curation === "auto"}
                onChange={() => setCuration("auto")}
              />
              Otomatik: ürünleri curate toplu işi profiline göre seçer.
            </label>
          </fieldset>
          <label className={styles.row}>
            <input
              type="checkbox"
              checked={featured}
              onChange={(event) => setFeatured(event.target.checked)}
            />
            Öne çıkar (yayınlandığında “Öne Çıkanlar” bölümünde)
          </label>
        </>
      ) : null}
      <label htmlFor={ids.reason}>
        <span className={styles.filterLabel}>Gerekçe (zorunlu, 5–500 karakter)</span>
        <textarea
          id={ids.reason}
          className={styles.textArea}
          required
          minLength={5}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      {message ? (
        <p
          role={message.error ? "alert" : "status"}
          className={message.error ? styles.statusBad : styles.muted}
        >
          {message.text}
          {message.href ? (
            <>
              {" "}
              <a href={message.href}>Yeniden giriş yap</a>
            </>
          ) : null}
        </p>
      ) : null}
      <div className={styles.row}>
        <Button type="submit" variant="primary" disabled={pending || reason.trim().length < 5}>
          {pending ? "Kaydediliyor…" : props.mode === "create" ? "Taslak oluştur" : "Kaydet"}
        </Button>
      </div>
    </form>
  );
}
