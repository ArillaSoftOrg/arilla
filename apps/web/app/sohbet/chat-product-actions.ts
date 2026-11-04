"use server";

import {
  canAccessProduct,
  createAlert,
  deleteAlert,
  findAlternatives,
  foreignHeadlineOffer,
  formatMinorWithCurrency,
  getProductForeignOffers,
  getProductPriceComparison,
  isChatDiscoveryEnabled,
  isUuid,
  listAlerts,
  listSavedItems,
  loadConversation,
  removeSavedItem,
  resolveProductSlug,
  saveItem,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { formatStartingPrice, formatTRY } from "@arilla/ui";
import { revalidatePath } from "next/cache";
import { verifySession } from "../lib/dal.ts";
import { chatToolProduct } from "./chat-product-display.ts";
import type {
  ChatPriceAlarm,
  ChatToolAccount,
  ChatToolDetail,
  ChatToolProduct,
  ChatToolResult,
} from "./chat-product-model.ts";

type Context = { db: ReturnType<typeof getDatabase>; userId: number };

/** Her eylem ürün kapısını ve sohbet sahipliğini kendisi denetler. */
async function inConversation<T>(
  id: string,
  work: (context: Context) => Promise<ChatToolResult<T>>,
): Promise<ChatToolResult<T>> {
  try {
    if (!isChatDiscoveryEnabled() || !isUuid(id)) return { status: "not_found" };
    const user = await verifySession();
    if (!user) return { status: "session_expired" };
    if (!canAccessProduct(user)) return { status: "not_found" };
    const db = getDatabase();
    if (!(await loadConversation(db, { userId: user.id, conversationId: id })))
      return { status: "not_found" };
    return await work({ db, userId: user.id });
  } catch (error) {
    console.error("[sohbet] product tool failed", error instanceof Error ? error.name : "unknown");
    return { status: "unavailable" };
  }
}

async function publishedProduct(context: Context, slug: string) {
  if (typeof slug !== "string" || !slug || slug.length > 500) return null;
  let result = await resolveProductSlug(context.db, slug);
  if (result.status === "redirect")
    result = await resolveProductSlug(context.db, result.canonicalSlug);
  return result.status === "found" ? result.product : null;
}

async function priceAlarms(context: Context): Promise<ChatPriceAlarm[]> {
  return (await listAlerts(context.db, context.userId))
    .filter((item) => item.kind === "price_drop" && item.isActive && item.targetPrice !== null)
    .map((item) => ({
      productId: item.productId,
      alertId: item.alertId,
      targetPrice: item.targetPrice as number,
    }));
}

export async function loadChatToolAccountAction(
  conversationId: string,
): Promise<ChatToolResult<{ account: ChatToolAccount }>> {
  return inConversation<{ account: ChatToolAccount }>(conversationId, async (context) => {
    const [saved, alarms] = await Promise.all([
      listSavedItems(context.db, context.userId),
      priceAlarms(context),
    ]);
    return {
      status: "ok",
      account: { savedProductIds: saved.map((item) => item.productId), alarms },
    };
  });
}

export async function setChatProductSavedAction(
  conversationId: string,
  slug: string,
  saved: boolean,
): Promise<ChatToolResult<{ saved: boolean }>> {
  return inConversation<{ saved: boolean }>(conversationId, async (context) => {
    if (typeof saved !== "boolean") return { status: "invalid" };
    const product = await publishedProduct(context, slug);
    if (!product) return { status: "not_found" };
    const input = { userId: context.userId, productId: product.productId };
    if (saved) await saveItem(context.db, input);
    else await removeSavedItem(context.db, input);
    revalidatePath("/kaydettiklerim");
    return { status: "ok", saved };
  });
}

export async function setChatPriceAlarmAction(
  conversationId: string,
  slug: string,
  targetPrice: number | null,
): Promise<ChatToolResult<{ alarm: ChatPriceAlarm | null }>> {
  return inConversation<{ alarm: ChatPriceAlarm | null }>(conversationId, async (context) => {
    if (targetPrice !== null && (!Number.isSafeInteger(targetPrice) || targetPrice <= 0))
      return { status: "invalid" };
    const product = await publishedProduct(context, slug);
    if (!product) return { status: "not_found" };
    if (targetPrice === null) {
      const existing = (await priceAlarms(context)).filter(
        (alarm) => alarm.productId === product.productId,
      );
      await Promise.all(
        existing.map((alarm) =>
          deleteAlert(context.db, { userId: context.userId, alertId: alarm.alertId }),
        ),
      );
      revalidatePath("/alarmlar");
      return { status: "ok", alarm: null };
    }
    const { merchantOffers } = await getProductPriceComparison(context.db, product.productId, null);
    if (merchantOffers.length === 0) return { status: "unsupported" };
    await createAlert(context.db, {
      userId: context.userId,
      productId: product.productId,
      kind: "price_drop",
      targetPrice,
    });
    const alarm = (await priceAlarms(context)).find((item) => item.productId === product.productId);
    if (!alarm) return { status: "unavailable" };
    revalidatePath("/alarmlar");
    return { status: "ok", alarm };
  });
}

export async function loadChatProductDetailsAction(
  conversationId: string,
  slugs: string[],
): Promise<ChatToolResult<{ products: ChatToolDetail[] }>> {
  return inConversation<{ products: ChatToolDetail[] }>(conversationId, async (context) => {
    if (
      !Array.isArray(slugs) ||
      slugs.length < 1 ||
      slugs.length > 3 ||
      new Set(slugs).size !== slugs.length
    )
      return { status: "invalid" };
    const products: ChatToolDetail[] = [];
    for (const slug of slugs) {
      const product = await publishedProduct(context, slug);
      if (!product) return { status: "not_found" };
      const { merchantOffers, comparison } = await getProductPriceComparison(
        context.db,
        product.productId,
        null,
      );
      const foreignOffers =
        merchantOffers.length === 0
          ? await getProductForeignOffers(context.db, product.productId)
          : [];
      const foreign = foreignHeadlineOffer(merchantOffers.length > 0, foreignOffers);
      const primary =
        merchantOffers.find((item) => item.inStock) ??
        merchantOffers.find((item) => item.stockUnknown) ??
        merchantOffers[0];
      const price =
        comparison.mode === "variants"
          ? comparison.startingPriceKurus
          : (primary?.currentPrice ?? null);
      products.push({
        productId: product.productId,
        slug: product.slug,
        title: product.title,
        imageUrl: product.primaryImageUrl,
        brand: product.brandName,
        color: product.color,
        displayPrice:
          price !== null
            ? comparison.mode === "variants"
              ? formatStartingPrice(price)
              : formatTRY(price)
            : foreign
              ? formatMinorWithCurrency(foreign.priceMinor, foreign.currency)
              : "Fiyat mağazada",
        ...(foreign ? { sourceLabel: "Yurt dışı" } : {}),
        meta: `${new Set(merchantOffers.map((item) => item.merchantId)).size || new Set(foreignOffers.map((item) => item.merchantName)).size} mağaza`,
        stock: merchantOffers.some((item) => item.inStock && !item.stockUnknown)
          ? "Stokta"
          : merchantOffers.length === 0 || merchantOffers.some((item) => item.stockUnknown)
            ? "Mağazada doğrula"
            : "Stokta yok",
        variants:
          comparison.mode === "variants" ? comparison.options.map((item) => item.label) : [],
        priceKurus: price,
        priceAlarmAvailable: merchantOffers.length > 0,
      });
    }
    return { status: "ok", products };
  });
}

export async function loadChatSimilarProductsAction(
  conversationId: string,
  slug: string,
): Promise<ChatToolResult<{ products: ChatToolProduct[] }>> {
  return inConversation<{ products: ChatToolProduct[] }>(conversationId, async (context) => {
    const product = await publishedProduct(context, slug);
    if (!product) return { status: "not_found" };
    const alternatives = await findAlternatives(context.db, product.productId, { limit: 6 });
    return { status: "ok", products: alternatives.map(chatToolProduct) };
  });
}
