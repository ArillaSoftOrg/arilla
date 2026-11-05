"use client";

import type { SearchIntent } from "@arilla/core";
import { createContext, useContext } from "react";
import type { ChatToolAccount, ChatToolBackend, ChatToolProduct } from "./chat-product-model.ts";

export type ChatToolPanel =
  | { kind: "menu" | "alarm" | "similar"; product: ChatToolProduct }
  | { kind: "compare" }
  | { kind: "filters"; intent: SearchIntent };

export interface ChatProductTools {
  /** Yalnızca tanıtım ekranının yerel örnek işlemleri için. */
  demoNotice?: string;
  backend: ChatToolBackend;
  account: ChatToolAccount | null;
  accountError: boolean;
  refreshAccount: () => Promise<void>;
  pendingSaves: number[];
  toggleSaved: (product: ChatToolProduct) => Promise<void>;
  setAlarm: (product: ChatToolProduct, price: number | null) => Promise<boolean>;
  selected: ChatToolProduct[];
  toggleCompare: (product: ChatToolProduct) => void;
  clearComparison: () => void;
  panel: ChatToolPanel | null;
  openPanel: (panel: ChatToolPanel) => void;
  closePanel: () => void;
  busy: boolean;
  prepareMessage: (message: string) => boolean;
}

export const ChatProductToolsContext = createContext<ChatProductTools | null>(null);
export const useChatProductTools = () => useContext(ChatProductToolsContext);
