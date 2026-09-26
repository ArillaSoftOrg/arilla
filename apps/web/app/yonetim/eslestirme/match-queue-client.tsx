"use client";

import { Badge, Button, Card } from "@arilla/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { formatKurus, REVIEW_REASON_LABELS } from "../format.ts";
import { approveMatchAction, rejectMatchAction } from "./actions.ts";

export interface MatchQueueClientItem {
  matchCandidateId: number;
  score: number;
  method: string;
  explain: {
    text_similarity?: number;
    review?: string | null;
    auto_eligible?: boolean;
    brand_known_both?: boolean;
    brand_equal?: boolean;
    queue_threshold?: number;
    auto_accept_threshold?: number;
  } | null;
  offer: {
    title: string;
    brand: string | null;
    imageUrl: string | null;
    attributes: Record<string, unknown>;
    merchantName: string;
    price: number | null;
    inStock: boolean;
    url: string | null;
    gtin: string | null;
    mpn: string | null;
    variants: {
      sizeLabel: string | null;
      sku: string | null;
      gtin: string | null;
      gtinSource: string | null;
      inStock: boolean;
    }[];
  };
  product: {
    id: number;
    slug: string;
    title: string;
    brand: string | null;
    imageUrl: string | null;
    attributes: Record<string, unknown>;
    gtin: string | null;
    mpn: string | null;
    minPrice: number | null;
    offerCount: number;
  };
}

/** 1–5 tuşlarının sırası; `superseded` insan seçimi değildir. */
const REASONS = [
  "not_same_product",
  "different_color",
  "different_size",
  "bad_data",
  "other",
] as const;
type Reason = (typeof REASONS)[number];

function valueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function attributesText(attributes: Record<string, unknown>): string {
  const entries = Object.entries(attributes).filter(([, value]) => valueText(value) !== "");
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}: ${valueText(value)}`).join(" · ");
}

const muted = { margin: 0, fontSize: 13, color: "var(--ink-muted)" } as const;

function Side({
  eyebrow,
  title,
  brand,
  imageUrl,
  attributes,
  children,
}: {
  eyebrow: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  attributes: Record<string, unknown>;
  children?: ReactNode;
}) {
  return (
    <Card style={{ display: "grid", gap: 8, padding: 16, alignContent: "start" }}>
      <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{eyebrow}</span>
      {imageUrl ? (
        // biome-ignore lint/performance/noImgElement: urun/[slug]/page.tsx ile ayni desen, keyfi merchant host'lari icin; adres sunucuda http(s) ile sinirli.
        <img
          src={imageUrl}
          alt={title}
          referrerPolicy="no-referrer"
          style={{
            width: "100%",
            aspectRatio: "1 / 1",
            objectFit: "cover",
            background: "var(--surface)",
          }}
        />
      ) : (
        <div
          style={{ width: "100%", aspectRatio: "1 / 1", background: "var(--surface)" }}
          aria-hidden="true"
        />
      )}
      <p style={{ margin: 0, fontWeight: 600 }}>{title}</p>
      {brand ? <p style={{ margin: 0, color: "var(--ink-muted)" }}>{brand}</p> : null}
      <p style={muted}>{attributesText(attributes)}</p>
      {children}
    </Card>
  );
}

function explainText(item: MatchQueueClientItem): string | null {
  const e = item.explain;
  if (!e) return null;
  const parts: string[] = [];
  if (typeof e.text_similarity === "number") {
    parts.push(`metin benzerliği ${e.text_similarity.toFixed(2)}`);
  }
  if (e.brand_known_both !== undefined) {
    parts.push(
      e.brand_equal ? "marka aynı" : e.brand_known_both ? "marka farklı" : "marka bilinmiyor",
    );
  }
  if (e.review) parts.push(`insan onayı gerekçesi: ${e.review}`);
  if (typeof e.auto_accept_threshold === "number") {
    parts.push(`otomatik kabul eşiği ${e.auto_accept_threshold.toFixed(2)}`);
  }
  return parts.join(" · ") || null;
}

/** pages.md: "Klavye kısayolu şart: bu ekran günde yüzlerce kez kullanılacak." */
export function MatchQueueClient({ items }: { items: MatchQueueClientItem[] }) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const current = items[index];

  const advance = useCallback(() => {
    setRejecting(false);
    setCopied(false);
    setIndex((i) => i + 1);
  }, []);

  const decide = useCallback(
    async (action: "approve" | "reject" | "skip", reason: Reason | null = null) => {
      if (!current || pending) return;
      setMessage(null);
      if (action === "skip") {
        advance();
        return;
      }
      setPending(true);
      try {
        const result =
          action === "approve"
            ? await approveMatchAction(current.matchCandidateId)
            : await rejectMatchAction(current.matchCandidateId, reason);
        if (result.conflict) {
          // Hiçbir şey değişmedi: teklif başka bir ürüne bağlı. Satırda kal.
          setMessage({
            text: "Bu teklif bu arada başka bir ürüne bağlanmış. Reddedebilir ya da atlayabilirsin.",
            error: true,
          });
          return;
        }
        if (!result.found) {
          setMessage({ text: "Bu satır başka bir yerde zaten karara bağlanmış.", error: false });
        }
        advance();
      } catch {
        // Hata sessizce yutulup sonraki satıra geçilmez: karar kaydedilmedi.
        setMessage({ text: "Karar kaydedilemedi. Tekrar dene.", error: true });
      } finally {
        setPending(false);
      }
    },
    [current, pending, advance],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const key = event.key.toLowerCase();
      if (rejecting) {
        if (key === "escape") setRejecting(false);
        else if (key === "0") void decide("reject", null);
        else if (/^[1-5]$/.test(key)) void decide("reject", REASONS[Number(key) - 1] ?? null);
        return;
      }
      if (key === "a") void decide("approve");
      else if (key === "r") setRejecting(true);
      else if (key === "s") void decide("skip");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [decide, rejecting]);

  if (!current) {
    return (
      <Card style={{ padding: 16 }}>
        <p style={{ margin: 0 }}>Bu grup bitti. Yeni bir grup için sayfayı yenile.</p>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setIndex(0);
            setMessage(null);
            router.refresh();
          }}
          style={{ marginTop: 12 }}
        >
          Yenile
        </Button>
      </Card>
    );
  }

  const explanation = explainText(current);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <p
        role="status"
        aria-live="polite"
        style={{
          margin: 0,
          minHeight: "1.5em",
          color: message?.error ? "var(--alert)" : "var(--ink-muted)",
        }}
      >
        {message?.text ?? ""}
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Badge>{`${index + 1} / ${items.length}`}</Badge>
        <Badge>{`skor ${current.score.toFixed(2)}`}</Badge>
        <Badge>{current.method}</Badge>
      </div>
      {explanation ? <p style={muted}>{explanation}</p> : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 16,
        }}
      >
        <Side
          eyebrow="Mağaza teklifi"
          title={current.offer.title}
          brand={current.offer.brand}
          imageUrl={current.offer.imageUrl}
          attributes={current.offer.attributes}
        >
          <p style={muted}>
            {`${current.offer.merchantName} · ${formatKurus(current.offer.price)} · ${
              current.offer.inStock ? "stokta" : "stokta yok"
            }`}
          </p>
          <p
            style={muted}
          >{`GTIN ${current.offer.gtin ?? "—"} · MPN ${current.offer.mpn ?? "—"}`}</p>
          {current.offer.variants.length > 0 ? (
            <table style={{ fontSize: 12, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--ink-muted)" }}>
                  <th scope="col">Boyut</th>
                  <th scope="col">SKU</th>
                  <th scope="col">GTIN</th>
                </tr>
              </thead>
              <tbody>
                {current.offer.variants.map((variant, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: varyant listesi sabit, yeniden sıralanmaz.
                  <tr key={i}>
                    <td>{variant.sizeLabel ?? "—"}</td>
                    <td>{variant.sku ?? "—"}</td>
                    <td>{variant.gtin ? `${variant.gtin} (${variant.gtinSource ?? "?"})` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {current.offer.url ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <code style={{ fontSize: 12, overflowWrap: "anywhere" }}>{current.offer.url}</code>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(current.offer.url ?? "")
                    .then(() => setCopied(true));
                }}
              >
                {copied ? "Kopyalandı" : "Adresi kopyala"}
              </Button>
            </div>
          ) : null}
        </Side>
        <Side
          eyebrow="Kayıtlı ürün"
          title={current.product.title}
          brand={current.product.brand}
          imageUrl={current.product.imageUrl}
          attributes={current.product.attributes}
        >
          <p style={muted}>
            {`${formatKurus(current.product.minPrice)}'den · ${current.product.offerCount} teklif`}
          </p>
          <p style={muted}>
            {`GTIN ${current.product.gtin ?? "—"} · MPN ${current.product.mpn ?? "—"}`}
          </p>
          <p style={muted}>
            <Link href={`/yonetim/katalog/urunler/${current.product.id}`}>Katalog ayrıntısı</Link>
            {" · "}
            <Link href={`/urun/${current.product.slug}`}>Ürün sayfası</Link>
          </p>
        </Side>
      </div>

      {rejecting ? (
        <Card style={{ display: "grid", gap: 8, padding: 16 }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Red nedeni</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {REASONS.map((reason, i) => (
              <Button
                key={reason}
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => decide("reject", reason)}
              >
                {`${i + 1} ${REVIEW_REASON_LABELS[reason]}`}
              </Button>
            ))}
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => decide("reject", null)}
            >
              0 Belirtmeden reddet
            </Button>
            <Button type="button" variant="secondary" onClick={() => setRejecting(false)}>
              Vazgeç (Esc)
            </Button>
          </div>
        </Card>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            type="button"
            variant="primary"
            disabled={pending}
            onClick={() => decide("approve")}
          >
            Onayla (A)
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => setRejecting(true)}
          >
            Reddet (R)
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => decide("skip")}
          >
            Atla (S)
          </Button>
        </div>
      )}
    </div>
  );
}
