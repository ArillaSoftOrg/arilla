"use client";

import type { SearchIntent } from "@arilla/core";
import { Button, CloseIcon, formatTRY, Input, ProductImage } from "@arilla/ui";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { ChatToolCard } from "./chat-product-cards.tsx";
import { type ChatProductTools, useChatProductTools } from "./chat-product-context.tsx";
import {
  CHAT_TOOL_ERRORS,
  type ChatFilterDraft,
  type ChatToolDetail,
  type ChatToolProduct,
  chatFilterDraft,
  chatFilterMessage,
  parseChatPrice,
} from "./chat-product-model.ts";
import styles from "./chat-product-tools.module.css";

export function ChatProductPanels() {
  const tools = useChatProductTools();
  return tools ? <Panels tools={tools} /> : null;
}

function Panels({ tools }: { tools: ChatProductTools }) {
  const { panel, backend } = tools;
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const [loadedRequest, setLoadedRequest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<ChatToolDetail[]>([]);
  const [alternatives, setAlternatives] = useState<ChatToolProduct[]>([]);
  const [retry, setRetry] = useState(0);
  const open = panel !== null;
  const request = JSON.stringify(
    panel?.kind === "filters" || panel?.kind === "menu" || !panel
      ? null
      : {
          kind: panel.kind,
          retry,
          slugs:
            panel.kind === "compare"
              ? tools.selected.map((item) => item.slug)
              : [panel.product.slug],
        },
  );
  const loading = request !== "null" && loadedRequest !== request;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      trigger.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    }
    if (!open && dialog.open) {
      dialog.close();
      if (trigger.current?.isConnected) trigger.current.focus();
    }
  }, [open]);

  useEffect(() => {
    if (panel) heading.current?.focus();
  }, [panel]);

  useEffect(() => {
    let current = true;
    const input = JSON.parse(request) as { kind: string; slugs: string[] } | null;
    setError(null);
    setDetails([]);
    setAlternatives([]);
    if (!input) {
      setLoadedRequest(request);
      return;
    }
    const pending =
      input.kind === "similar"
        ? backend.similar(input.slugs[0] ?? "")
        : backend.details(input.slugs);
    void pending
      .then((result) => {
        if (!current) return;
        if (result.status !== "ok") setError(CHAT_TOOL_ERRORS[result.status]);
        else if (input.kind === "similar") setAlternatives(result.products);
        else setDetails(result.products as ChatToolDetail[]);
      })
      .catch(() => {
        if (current) setError(CHAT_TOOL_ERRORS.unavailable);
      })
      .finally(() => {
        if (current) setLoadedRequest(request);
      });
    return () => {
      current = false;
    };
  }, [backend, request]);

  const title =
    panel?.kind === "menu"
      ? "Ürün işlemleri"
      : panel?.kind === "alarm"
        ? "Fiyat alarmı"
        : panel?.kind === "similar"
          ? "Benzer ürünler"
          : panel?.kind === "compare"
            ? "Seçtiklerini karşılaştır"
            : "Aramanı düzenle";

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      data-kind={panel?.kind}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        tools.closePanel();
      }}
    >
      <div className={styles.dialogHeader}>
        <h2 id={titleId} ref={heading} tabIndex={-1}>
          {title}
        </h2>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Paneli kapat"
          onClick={tools.closePanel}
        >
          <CloseIcon />
        </button>
      </div>
      <div className={styles.dialogBody}>
        {tools.demoNotice ? <p className={styles.muted}>{tools.demoNotice}</p> : null}
        {panel && "product" in panel ? <p className={styles.muted}>{panel.product.title}</p> : null}
        {panel?.kind === "menu" ? (
          <div className={styles.form}>
            {tools.accountError ? (
              <Button onClick={() => void tools.refreshAccount()}>Kaydetme durumunu yenile</Button>
            ) : null}
            <Button
              variant="secondary"
              disabled={!tools.account}
              onClick={() => tools.openPanel({ kind: "alarm", product: panel.product })}
            >
              {tools.account?.alarms.some((item) => item.productId === panel.product.productId)
                ? "Fiyat alarmını gör"
                : "Fiyat alarmı kur"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => tools.openPanel({ kind: "similar", product: panel.product })}
            >
              Benzerlerini bul
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                tools.toggleCompare(panel.product);
                tools.closePanel();
              }}
            >
              {tools.selected.some((item) => item.productId === panel.product.productId)
                ? "Karşılaştırmadan çıkar"
                : "Karşılaştırmaya ekle"}
            </Button>
          </div>
        ) : null}
        {loading ? <p role="status">Ürün bilgileri yükleniyor…</p> : null}
        {!loading && error ? (
          <div role="alert">
            <p>{error}</p>
            <Button onClick={() => setRetry((value) => value + 1)}>Tekrar dene</Button>
          </div>
        ) : null}
        {!loading && !error && panel?.kind === "alarm" && details[0] ? (
          <AlarmForm key={panel.product.productId} tools={tools} product={details[0]} />
        ) : null}
        {!loading && !error && panel?.kind === "similar" ? (
          <>
            <p className={styles.muted}>
              Bu ürüne benzer seçenekler. Benzer ürünler, aynı ürün olmayabilir.
            </p>
            {alternatives.length > 0 ? (
              <ul className={styles.similarGrid}>
                {alternatives.map((product) => (
                  <li key={product.productId}>
                    <ChatToolCard product={product} />
                  </li>
                ))}
              </ul>
            ) : (
              <p>Bu ürün için şu an listelenecek benzer bir seçenek bulunamadı.</p>
            )}
          </>
        ) : null}
        {!loading && !error && panel?.kind === "compare" && details.length > 0 ? (
          <Comparison tools={tools} products={details} />
        ) : null}
        {panel?.kind === "filters" ? (
          <FilterForm key={JSON.stringify(panel.intent)} tools={tools} intent={panel.intent} />
        ) : null}
      </div>
    </dialog>
  );
}

function AlarmForm({ tools, product }: { tools: ChatProductTools; product: ChatToolDetail }) {
  const [price, setPrice] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const writing = useRef(false);
  const alarm = tools.account?.alarms.find((item) => item.productId === product.productId);
  async function change(target: number | null) {
    if (writing.current) return;
    writing.current = true;
    setPending(true);
    setError("");
    try {
      if (!(await tools.setAlarm(product, target)))
        setError("Alarm değiştirilemedi. Tekrar deneyebilirsin.");
    } finally {
      writing.current = false;
      setPending(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const amount = parseChatPrice(price);
    if (amount === null) {
      setError("Geçerli bir hedef fiyat yaz. Örneğin 2500 veya 2500,50.");
      return;
    }
    void change(amount);
  }
  if (!tools.account)
    return (
      <p>
        Alarm bilgisi alınamadı.{" "}
        <button type="button" onClick={() => void tools.refreshAccount()}>
          Tekrar dene
        </button>
      </p>
    );
  return (
    <div className={styles.form}>
      {!tools.demoNotice ? (
        <p>
          Güncel fiyat: <strong>{product.displayPrice}</strong>
        </p>
      ) : null}
      {alarm ? (
        <>
          <p role="status">
            {tools.demoNotice
              ? `Örnekte hedef fiyatın: ${formatTRY(alarm.targetPrice)}. Gerçek bildirim gönderilmez.`
              : `${formatTRY(alarm.targetPrice)} altına düşünce haber verecek bir alarmın var.`}
          </p>
          <Button disabled={pending} onClick={() => void change(null)}>
            {pending ? "Kaldırılıyor…" : "Alarmı kaldır"}
          </Button>
        </>
      ) : product.priceAlarmAvailable ? (
        <form onSubmit={submit} className={styles.form}>
          <Input
            label="Kaç TL altına düşünce haber verelim?"
            inputMode="decimal"
            placeholder="Örneğin 2500"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            disabled={pending}
            required
          />
          <Button type="submit" variant="accent" disabled={pending}>
            {pending ? "Kuruluyor…" : "Fiyat alarmı kur"}
          </Button>
        </form>
      ) : (
        <p>
          Bu ürün için şu an TL fiyat alarmı kurulamıyor. Güncel fiyatı ürün sayfasından
          inceleyebilirsin.
        </p>
      )}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Comparison({ tools, products }: { tools: ChatProductTools; products: ChatToolDetail[] }) {
  const rows: { label: string; value: (product: ChatToolDetail) => string }[] = [
    { label: "Fiyat", value: (item) => item.displayPrice },
    { label: "Marka", value: (item) => item.brand ?? "Belirtilmemiş" },
    { label: "Renk", value: (item) => item.color ?? "Belirtilmemiş" },
    { label: "Mağaza", value: (item) => item.meta },
    { label: "Stok", value: (item) => item.stock },
    {
      label: "Seçenekler",
      value: (item) =>
        item.variants.length ? item.variants.slice(0, 12).join(", ") : "Ürün sayfasında incele",
    },
  ];
  return (
    <>
      <section className={styles.comparisonScroll} aria-label="Ürün karşılaştırma tablosu">
        <table className={styles.comparison}>
          <caption>Seçtiğin ürünlerin mevcut bilgileri</caption>
          <thead>
            <tr>
              <th scope="col">Ürün</th>
              {products.map((product) => (
                <th scope="col" key={product.productId}>
                  {product.imageUrl ? (
                    <ProductImage
                      src={product.imageUrl}
                      alt=""
                      className={styles.compareImage}
                      fit="contain"
                    />
                  ) : null}
                  <a href={`/urun/${product.slug}`}>{product.title}</a>
                  {product.sourceLabel ? (
                    <p className={styles.muted}>{product.sourceLabel}</p>
                  ) : null}
                  <button
                    type="button"
                    className={styles.textButton}
                    onClick={() => tools.toggleCompare(product)}
                  >
                    Seçimden çıkar
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                {products.map((product) => (
                  <td key={product.productId}>{row.value(product)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className={styles.muted}>
        Başlangıç fiyatları farklı beden veya seçeneklere ait olabilir. Güncel fiyat ve stok
        bilgisini mağazada doğrula.
      </p>
    </>
  );
}

function FilterForm({ tools, intent }: { tools: ChatProductTools; intent: SearchIntent }) {
  const [draft, setDraft] = useState(() => chatFilterDraft(intent));
  const [error, setError] = useState("");
  const fields: { key: keyof ChatFilterDraft; label: string; numeric?: boolean }[] = [
    { key: "brand", label: "Marka" },
    { key: "colors", label: "Renk (birden fazlaysa virgülle ayır)" },
    { key: "size", label: "Beden" },
    { key: "priceMin", label: "En az bütçe (TL)", numeric: true },
    { key: "priceMax", label: "En fazla bütçe (TL)", numeric: true },
  ];
  function submit(event: FormEvent) {
    event.preventDefault();
    const message = chatFilterMessage(intent, draft);
    if (message === null) {
      setError("Tercihleri ve bütçe aralığını kontrol et. Bütçeyi tam TL olarak yazabilirsin.");
      return;
    }
    if (!message) {
      setError("Henüz bir tercihi değiştirmedin.");
      return;
    }
    if (tools.prepareMessage(message)) tools.closePanel();
    else setError("Mesaj hazırlanamadı. Mevcut mesajını kontrol edip tekrar deneyebilirsin.");
  }
  return (
    <form onSubmit={submit} className={styles.form}>
      <p className={styles.muted}>Aradığın ürün: {intent.query}</p>
      {fields.map(({ key, label, numeric }) => (
        <Input
          key={key}
          label={label}
          value={draft[key]}
          maxLength={numeric ? 8 : 60}
          inputMode={numeric ? "numeric" : "text"}
          disabled={tools.busy}
          onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
        />
      ))}
      <p className={styles.muted}>
        {tools.demoNotice
          ? "Bir tercihi kaldırmak için alanı boş bırak. Tercihlerin örnek mesaj kutusuna eklenecek; bu tanıtımda gerçek arama yapılmaz."
          : "Bir tercihi kaldırmak için alanı boş bırak. Değişiklikler mesaj kutusuna eklenecek; gönderdiğinde araman güncellenecek."}
      </p>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      <Button variant="accent" type="submit" disabled={tools.busy}>
        Mesajı hazırla
      </Button>
    </form>
  );
}
