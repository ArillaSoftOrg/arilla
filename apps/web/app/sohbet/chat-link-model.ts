import type {
  ChatLinkView,
  LinkPreferenceOutcome,
  LinkSearchResults,
  LinkSource,
} from "@arilla/core";
import { formatTRY } from "@arilla/ui";
import { CHAT_LINK_COPY, unappliedPreferenceLabel } from "./chat-copy.ts";

/** Kaynak fiyatı yalnızca yapılandırılmış veriden, para birimiyle birlikte geldiyse; yoksa gösterilmez. */
export function formatSourcePrice(source: Pick<LinkSource, "price" | "currency">): string | null {
  if (source.price === null || source.currency === null) return null;
  if (source.currency === "TRY") return formatTRY(source.price);
  const whole = (source.price / 100).toLocaleString("tr-TR", {
    minimumFractionDigits: source.price % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${whole} ${source.currency}`;
}

/** Çekirdek görünümü -> ekran durumu. `stale` sabit bir hata kodudur (chatLinkFailureCopy). */
export type ChatLinkScreen =
  | { kind: "pending" }
  | { kind: "failure"; code: string }
  | { kind: "resolved"; textOnly: boolean };

export function linkScreenFor(view: ChatLinkView): ChatLinkScreen {
  switch (view.state) {
    case "pending":
      return { kind: "pending" };
    case "stale":
      return { kind: "failure", code: "stale" };
    case "failed":
      return { kind: "failure", code: view.errorCode };
    case "resolved":
      return { kind: "resolved", textOnly: view.textOnly };
  }
}

export function hasLinkResults(results: Pick<LinkSearchResults, "same" | "similar">): boolean {
  return results.same.length + results.similar.length > 0;
}

/** Uygulanamayan tercihlerin şeffaflık notu; yoksa `null`. */
export function unappliedNote(outcome: Pick<LinkPreferenceOutcome, "unapplied">): string | null {
  const labels = outcome.unapplied
    .map((key) => unappliedPreferenceLabel(key))
    .filter((label): label is string => label !== null);
  if (labels.length === 0) return null;
  const lead = labels.length > 1 ? CHAT_LINK_COPY.unappliedLeadMany : CHAT_LINK_COPY.unappliedLead;
  return `${lead} ${labels.join(", ")}.`;
}

/** Tercih yüzünden elenen ürün notu; yoksa `null`. */
export function droppedNote(
  outcome: Pick<LinkPreferenceOutcome, "droppedByPreferences">,
): string | null {
  return outcome.droppedByPreferences > 0
    ? CHAT_LINK_COPY.droppedByPreferences(outcome.droppedByPreferences)
    : null;
}
