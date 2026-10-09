import { CHAT_FEEDBACK_COMMENT_MAX, CHAT_FEEDBACK_REASONS, type SearchIntent } from "@arilla/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CHAT_COPY } from "./chat-copy.ts";
import { ResultFeedback } from "./chat-feedback-client.tsx";
import { fullResultsHref } from "./chat-results.tsx";
import { araSortParam, parseSortKey, sortModeFor } from "./chat-sort.ts";
import { ResultTabs } from "./chat-tabs.tsx";
import { FEEDBACK_COMMENT_MAX, FEEDBACK_REASON_CODES, FeedbackDialog } from "./feedback-dialog.tsx";

vi.mock("./actions.ts", () => ({ submitResultFeedbackAction: vi.fn() }));

const INTENT: SearchIntent = {
  query: "beyaz spor ayakkabı",
  category: null,
  brand: null,
  excludeBrands: [],
  colors: [],
  size: null,
  priceMin: null,
  priceMax: null,
  attributes: {},
  sort: null,
};

describe("sort tabs map to existing search sorts", () => {
  it("Seçtiklerimiz = balanced (default), En iyi fırsatlar = best_deal", () => {
    expect(sortModeFor("secilen")).toBe("balanced");
    expect(sortModeFor("firsat")).toBe("best_deal");
    expect(parseSortKey(undefined, INTENT)).toBe("secilen");
    expect(parseSortKey("firsat", INTENT)).toBe("firsat");
  });

  it("closest_match needs a product anchor: the third tab cannot be selected on text search", () => {
    expect(parseSortKey("eslesme", INTENT)).toBe("secilen");
  });

  it("a 'daha uygun fiyatlı' intent opens the deals tab by default; explicit choice wins", () => {
    const cheap = { ...INTENT, sort: "cheapest" as const };
    expect(parseSortKey(undefined, cheap)).toBe("firsat");
    expect(parseSortKey("secilen", cheap)).toBe("secilen");
  });

  it("garbage sort params fall back safely", () => {
    expect(parseSortKey("'; drop", INTENT)).toBe("secilen");
  });

  it("'Tüm sonuçlar' keeps the ranking in the /ara link", () => {
    expect(araSortParam("firsat")).toBe("best_deal");
    expect(fullResultsHref(INTENT, "firsat")).toContain("sort=best_deal");
    expect(fullResultsHref(INTENT, "secilen")).not.toContain("sort=");
  });
});

describe("ResultTabs", () => {
  const html = (active: "secilen" | "firsat", countLabel: string | null) =>
    renderToStaticMarkup(createElement(ResultTabs, { conversationId: "c-1", active, countLabel }));

  it("renders the three tabs with the active one marked, count on the right, no 'Bulduklarım'", () => {
    const out = html("firsat", "75 sonuç");
    expect(out).toContain(CHAT_COPY.tabSelected);
    expect(out).toContain(CHAT_COPY.tabDeals);
    expect(out).toContain(CHAT_COPY.tabMatches);
    expect(out).toContain("75 sonuç");
    expect(out).not.toContain("Bulduklarım");
    expect(out.match(/aria-current="true"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-current="true"[^>]*>[^<]*En iyi fırsatlar/);
    expect(out).toContain('href="/sohbet/c-1?sirala=firsat"');
    expect(out).toContain('href="/sohbet/c-1?sirala=secilen"');
  });

  it("the unsupported tab is disabled with a visible reason, not a link", () => {
    const out = html("secilen", null);
    expect(out).toContain('aria-disabled="true"');
    expect(out).toContain(CHAT_COPY.tabMatchesUnavailable);
    expect(out).not.toContain("sirala=eslesme");
  });
});

describe("ResultFeedback", () => {
  it("shows the question with two labelled buttons and reflects the saved vote", () => {
    const out = renderToStaticMarkup(
      createElement(ResultFeedback, { conversationId: "c", messageSeq: 2, initial: true }),
    );
    expect(out).toContain(CHAT_COPY.feedbackQuestion);
    expect(out).toContain(`aria-label="${CHAT_COPY.feedbackYes}"`);
    expect(out).toContain(`aria-label="${CHAT_COPY.feedbackNo}"`);
    expect(out).toMatch(/aria-pressed="true"[^>]*aria-label="Evet/);
    expect(out).toContain(CHAT_COPY.feedbackThanks);
  });
});

describe("FeedbackDialog (karar 0079)", () => {
  const markup = renderToStaticMarkup(
    createElement(FeedbackDialog, {
      open: false,
      pending: false,
      error: null,
      onCancel: () => {},
      onSubmit: () => {},
    }),
  );

  it("is a labelled native dialog with a reason select, an optional comment and two buttons", () => {
    expect(markup).toMatch(/<dialog[^>]*aria-labelledby=/);
    expect(markup).toContain(CHAT_COPY.feedbackDialogTitle);
    expect(markup).toContain(CHAT_COPY.feedbackReasonPlaceholder);
    expect(markup).toContain(CHAT_COPY.feedbackCancel);
    expect(markup).toContain(CHAT_COPY.feedbackSubmit);
    expect(markup).toContain(`maxLength="${FEEDBACK_COMMENT_MAX}"`);
    expect(markup).not.toContain("required");
  });

  it("offers exactly the reason codes the server accepts, with Turkish labels", () => {
    expect([...FEEDBACK_REASON_CODES]).toEqual([...CHAT_FEEDBACK_REASONS]);
    expect(FEEDBACK_COMMENT_MAX).toBe(CHAT_FEEDBACK_COMMENT_MAX);
    for (const code of FEEDBACK_REASON_CODES) {
      expect(markup).toContain(`value="${code}"`);
      expect(markup).toContain(CHAT_COPY.feedbackReasons[code]);
    }
  });

  it("shows a role=alert error only when given and disables controls while pending", () => {
    const failed = renderToStaticMarkup(
      createElement(FeedbackDialog, {
        open: true,
        pending: true,
        error: CHAT_COPY.feedbackFailed,
        onCancel: () => {},
        onSubmit: () => {},
      }),
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(CHAT_COPY.feedbackSubmitting);
    expect(markup).not.toContain('role="alert"');
  });

  it("copy has no ALL CAPS words or banned terms", () => {
    const texts = [
      CHAT_COPY.feedbackDialogTitle,
      CHAT_COPY.feedbackRateLimited,
      CHAT_COPY.feedbackCommentHint,
      ...Object.values(CHAT_COPY.feedbackReasons),
    ];
    for (const text of texts) {
      expect(text).not.toMatch(/\b[A-ZÇĞİÖŞÜ]{4,}\b/);
      expect(text.toLowerCase()).not.toMatch(/satın al|dupe|ucuz/);
    }
  });
});
