"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import styles from "../admin.module.css";
import { searchTrendProductsAction, setTrendProductsAction } from "./actions.ts";
import type { TrendProductCardView } from "./card-view.ts";
import { TrendProductCardBody } from "./trend-product-card.tsx";

/**
 * Elle seçilmiş koleksiyonun ürünleri (karar 0149): katalogda ara, ekle/çıkar, sürükle-bırak
 * ya da yukarı/aşağı düğmeleriyle sırala, gerekçeyle kaydet. Değişiklikler kaydedilene kadar
 * yalnızca bu ekrandadır. Kayıt, sayfanın açıldığı andaki sıralı listeyi `expected` olarak
 * gönderir: arada başka biri değiştirdiyse reddedilir. Sürükle-bırak isteğe bağlıdır; aynı
 * işlem klavyeyle düğmelerle yapılır.
 */
export function TrendProductsClient({
  trendId,
  initial,
  editable,
  minProducts,
  maxProducts,
  published,
}: {
  trendId: number;
  initial: TrendProductCardView[];
  /** `manual` ve arşivde değil. */
  editable: boolean;
  minProducts: number;
  maxProducts: number;
  published: boolean;
}) {
  const router = useRouter();
  const reasonId = useId();
  const searchId = useId();
  const [items, setItems] = useState(initial);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TrendProductCardView[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean; href?: string } | null>(
    null,
  );
  const [searching, startSearch] = useTransition();
  const [saving, startSave] = useTransition();

  const baseline = initial.map((card) => card.id);
  const current = items.map((card) => card.id);
  const dirty = baseline.join(",") !== current.join(",");
  const showable = items.filter((card) => card.showable).length;
  const selected = new Set(current);

  function move(from: number, to: number) {
    if (to < 0 || to >= items.length || from === to) return;
    setItems((list) => {
      const next = [...list];
      const [card] = next.splice(from, 1);
      if (card) next.splice(to, 0, card);
      return next;
    });
  }

  function search(before?: number) {
    setSearchMessage(null);
    startSearch(async () => {
      const response = await searchTrendProductsAction({ query, before });
      if (!response.ok) {
        setSearchMessage(response.message);
        return;
      }
      setResults((old) => (before ? [...old, ...response.rows] : response.rows));
      setNextBefore(response.nextBefore);
      if (!before && response.rows.length === 0) setSearchMessage("Yayında eşleşen ürün yok.");
    });
  }

  function save() {
    setMessage(null);
    startSave(async () => {
      const response = await setTrendProductsAction({
        trendId,
        productIds: current,
        expectedProductIds: baseline,
        reason,
      });
      if (!response.ok) {
        setMessage({ text: response.message, error: true, href: response.reauthHref });
        return;
      }
      setReason("");
      setMessage({ text: response.changed ? "Kaydedildi." : "Değişiklik yok.", error: false });
      router.refresh();
    });
  }

  return (
    <div className={styles.formGrid}>
      <p className={showable >= minProducts ? styles.statusGood : styles.statusWarn}>
        {`Gösterilebilir ürün: ${showable} / ${items.length} (yayın için en az ${minProducts}; en çok ${maxProducts} ürün).`}
        {published && showable < minProducts
          ? " Yayındaki koleksiyon eşiğin altına indirilemez."
          : null}
      </p>

      {items.length === 0 ? (
        <p className={styles.muted}>Henüz ürün yok.</p>
      ) : (
        <ol className={styles.list}>
          {items.map((card, index) => (
            <li
              key={card.id}
              draggable={editable}
              onDragStart={() => setDragIndex(index)}
              onDragOver={(event) => {
                if (editable && dragIndex !== null) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragIndex !== null) move(dragIndex, index);
                setDragIndex(null);
              }}
              onDragEnd={() => setDragIndex(null)}
            >
              <span className={styles.row}>
                <span className={styles.num}>{index + 1}</span>
                <TrendProductCardBody card={card} />
                {editable ? (
                  <span className={styles.row}>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={index === 0}
                      onClick={() => move(index, index - 1)}
                      aria-label={`${card.title}: yukarı taşı`}
                    >
                      Yukarı
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={index === items.length - 1}
                      onClick={() => move(index, index + 1)}
                      aria-label={`${card.title}: aşağı taşı`}
                    >
                      Aşağı
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setItems((list) => list.filter((c) => c.id !== card.id))}
                      aria-label={`${card.title}: koleksiyondan çıkar`}
                    >
                      Çıkar
                    </Button>
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      )}

      {editable ? (
        <>
          <form
            className={styles.row}
            onSubmit={(event) => {
              event.preventDefault();
              search();
            }}
          >
            <label htmlFor={searchId}>
              <span className={styles.meta}>
                Katalogda ara (başlık, ürün kimliği ya da GTIN; yalnızca yayındaki ürünler)
              </span>
              <input
                id={searchId}
                className={styles.textInput}
                minLength={2}
                maxLength={200}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <Button
              type="submit"
              variant="secondary"
              disabled={searching || query.trim().length < 2}
            >
              {searching ? "Aranıyor…" : "Ara"}
            </Button>
          </form>
          {searchMessage ? <p className={styles.muted}>{searchMessage}</p> : null}
          {results.length > 0 ? (
            <ul className={styles.list}>
              {results.map((card) => (
                <li key={card.id}>
                  <span className={styles.row}>
                    <TrendProductCardBody card={card} />
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={selected.has(card.id) || items.length >= maxProducts}
                      onClick={() => setItems((list) => [...list, card])}
                      aria-label={`${card.title}: koleksiyona ekle`}
                    >
                      {selected.has(card.id) ? "Eklendi" : "Ekle"}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {nextBefore ? (
            <Button
              type="button"
              variant="secondary"
              disabled={searching}
              onClick={() => search(nextBefore)}
            >
              Daha fazla sonuç
            </Button>
          ) : null}

          <label htmlFor={reasonId}>
            <span className={styles.filterLabel}>Gerekçe (zorunlu, 5–500 karakter)</span>
            <textarea
              id={reasonId}
              className={styles.textArea}
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
            <Button
              type="button"
              variant="primary"
              disabled={saving || !dirty || reason.trim().length < 5}
              onClick={save}
            >
              {saving ? "Kaydediliyor…" : "Ürünleri kaydet"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={saving || !dirty}
              onClick={() => setItems(initial)}
            >
              Değişiklikleri geri al
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
