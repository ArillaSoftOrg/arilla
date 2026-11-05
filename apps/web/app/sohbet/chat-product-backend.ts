"use client";

import {
  loadChatProductDetailsAction,
  loadChatSimilarProductsAction,
  loadChatToolAccountAction,
  setChatPriceAlarmAction,
  setChatProductSavedAction,
} from "./chat-product-actions.ts";
import type { ChatToolBackend } from "./chat-product-model.ts";

export function chatProductBackend(conversationId: string): ChatToolBackend {
  return {
    account: () => loadChatToolAccountAction(conversationId),
    save: (slug, saved) => setChatProductSavedAction(conversationId, slug, saved),
    alarm: (slug, price) => setChatPriceAlarmAction(conversationId, slug, price),
    details: (slugs) => loadChatProductDetailsAction(conversationId, slugs),
    similar: (slug) => loadChatSimilarProductsAction(conversationId, slug),
  };
}
