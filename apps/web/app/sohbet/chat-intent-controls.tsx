"use client";

import type { IntentChip, SearchIntent } from "@arilla/core";
import { useChatProductTools } from "./chat-product-context.tsx";
import { chatFilterDraft, chatFilterMessage } from "./chat-product-model.ts";
import styles from "./chat-product-tools.module.css";
import chatStyles from "./sohbet.module.css";

export function ChatIntentControls({
  intent,
  chips,
}: {
  intent: SearchIntent;
  chips: readonly IntentChip[];
}) {
  const tools = useChatProductTools();
  function remove(key: string) {
    const draft = chatFilterDraft(intent);
    if (key === "price") {
      draft.priceMin = "";
      draft.priceMax = "";
    } else if (key === "brand" || key === "colors" || key === "size") draft[key] = "";
    const message = chatFilterMessage(intent, draft);
    if (message) tools?.prepareMessage(message);
  }
  return (
    <div>
      <ul className={chatStyles.chips} aria-label="Aramada kullanılanlar">
        {chips.map((chip) => (
          <li key={chip.key} className={chatStyles.chip}>
            {chip.label}
            {tools && ["brand", "colors", "size", "price"].includes(chip.key) ? (
              <button
                type="button"
                className={styles.removeChip}
                aria-label={`${chip.label} tercihini kaldırmak için mesaj hazırla`}
                disabled={tools.busy}
                onClick={() => remove(chip.key)}
              >
                ×
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {tools ? (
        <button
          type="button"
          className={styles.editFilters}
          disabled={tools.busy}
          onClick={() => tools.openPanel({ kind: "filters", intent })}
        >
          Filtreleri düzenle
        </button>
      ) : null}
    </div>
  );
}
