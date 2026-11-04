"use client";

import { Button, CloseIcon, HeartIcon, ProductCard } from "@arilla/ui";
import { useChatProductTools } from "./chat-product-context.tsx";
import type { ChatToolProduct } from "./chat-product-model.ts";
import styles from "./chat-product-tools.module.css";

export function ChatCardActions({ product }: { product: ChatToolProduct }) {
  const tools = useChatProductTools();
  if (!tools) return null;
  const saved = tools.account?.savedProductIds.includes(product.productId) ?? false;
  return (
    <div className={styles.cardActions}>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={`${saved ? "Kaydettiklerinden kaldır" : "Kaydet"}: ${product.title}`}
        title={tools.accountError ? "Kaydetme durumu alınamadı" : saved ? "Kaydedildi" : "Kaydet"}
        aria-pressed={saved}
        disabled={!tools.account || tools.pendingSaves.includes(product.productId)}
        onClick={() => void tools.toggleSaved(product)}
      >
        <HeartIcon filled={saved} size={20} />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={`Ürün işlemleri: ${product.title}`}
        onClick={() => tools.openPanel({ kind: "menu", product })}
      >
        <span aria-hidden="true">⋯</span>
      </button>
    </div>
  );
}

export function ChatToolCard({ product }: { product: ChatToolProduct }) {
  return (
    <ProductCard
      href={`/urun/${product.slug}`}
      title={product.title}
      imageUrl={product.imageUrl}
      brand={product.brand}
      minPrice={null}
      priceLabel={product.displayPrice}
      sourceLabel={product.sourceLabel}
      offerCount={1}
      offerCountLabel={() => product.meta}
      action={<ChatCardActions product={product} />}
    />
  );
}

export function ChatCompareTray() {
  const tools = useChatProductTools();
  if (!tools || tools.selected.length === 0) return null;
  return (
    <section className={styles.compareTray} aria-label="Karşılaştırmak için seçilenler">
      <div className={styles.selectionText}>
        <strong>{tools.selected.length} ürün seçili</strong>
        <span>{tools.selected.map((item) => item.title).join(" · ")}</span>
      </div>
      <Button
        variant="accent"
        disabled={tools.selected.length < 2}
        onClick={() => tools.openPanel({ kind: "compare" })}
      >
        Karşılaştır
      </Button>
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Karşılaştırma seçimini temizle"
        onClick={tools.clearComparison}
      >
        <CloseIcon size={18} />
      </button>
    </section>
  );
}
