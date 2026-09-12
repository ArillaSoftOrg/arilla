"use client";

import { Badge, Button, Card } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { approveMatchAction, rejectMatchAction } from "./actions.ts";

export interface MatchQueueClientItem {
  matchCandidateId: number;
  score: number;
  method: string;
  offer: {
    title: string;
    brand: string | null;
    imageUrl: string | null;
    attributes: Record<string, unknown>;
    merchantName: string;
  };
  product: {
    slug: string;
    title: string;
    brand: string | null;
    imageUrl: string | null;
    attributes: Record<string, unknown>;
  };
}

function attributesText(attributes: Record<string, unknown>): string {
  const entries = Object.entries(attributes).filter(([, value]) => value !== null && value !== "");
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}: ${value}`).join(" · ");
}

function Side({
  eyebrow,
  title,
  brand,
  imageUrl,
  attributes,
  footnote,
}: {
  eyebrow: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  attributes: Record<string, unknown>;
  footnote?: string;
}) {
  return (
    <Card style={{ display: "grid", gap: 8, padding: 16 }}>
      <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{eyebrow}</span>
      {imageUrl ? (
        // biome-ignore lint/performance/noImgElement: urun/[slug]/page.tsx ile ayni desen, keyfi merchant host'lari icin.
        <img
          src={imageUrl}
          alt={title}
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
      <p style={{ margin: 0, fontSize: 13, color: "var(--ink-muted)" }}>
        {attributesText(attributes)}
      </p>
      {footnote ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>{footnote}</p>
      ) : null}
    </Card>
  );
}

/** pages.md: "Klavye kısayolu şart: bu ekran günde yüzlerce kez kullanılacak." */
export function MatchQueueClient({ items }: { items: MatchQueueClientItem[] }) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const current = items[index];

  const advance = useCallback(() => {
    setIndex((i) => i + 1);
  }, []);

  const decide = useCallback(
    async (action: "approve" | "reject" | "skip") => {
      if (!current || pending) return;
      if (action === "skip") {
        advance();
        return;
      }
      setPending(true);
      try {
        const runner = action === "approve" ? approveMatchAction : rejectMatchAction;
        await runner(current.matchCandidateId);
      } finally {
        setPending(false);
        advance();
      }
    },
    [current, pending, advance],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "a") void decide("approve");
      else if (key === "r") void decide("reject");
      else if (key === "s") void decide("skip");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [decide]);

  if (!current) {
    return (
      <Card style={{ padding: 16 }}>
        <p style={{ margin: 0 }}>Bu grup bitti. Yeni bir grup için sayfayı yenile.</p>
        <Button
          type="button"
          variant="secondary"
          onClick={() => router.refresh()}
          style={{ marginTop: 12 }}
        >
          Yenile
        </Button>
      </Card>
    );
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Badge>{`${index + 1} / ${items.length}`}</Badge>
        <Badge>{`skor ${current.score.toFixed(2)}`}</Badge>
        <Badge>{current.method}</Badge>
      </div>

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
          footnote={current.offer.merchantName}
        />
        <Side
          eyebrow="Kayıtlı ürün"
          title={current.product.title}
          brand={current.product.brand}
          imageUrl={current.product.imageUrl}
          attributes={current.product.attributes}
          footnote={`/urun/${current.product.slug}`}
        />
      </div>

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
          onClick={() => decide("reject")}
        >
          Reddet (R)
        </Button>
        <Button type="button" variant="secondary" disabled={pending} onClick={() => decide("skip")}>
          Atla (S)
        </Button>
      </div>
    </div>
  );
}
