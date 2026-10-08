import type { ChatMessageView, SearchIntent } from "@arilla/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CHAT_COPY, CHAT_ERROR_COPY, errorKindForStatus, relaxationLabel } from "./chat-copy.ts";
import { ChatResultGrid, fullResultsHref } from "./chat-results.tsx";
import { ChatThread } from "./chat-thread.tsx";

const INTENT: SearchIntent = {
  query: "günlük spor ayakkabı",
  category: null,
  brand: "Nike",
  excludeBrands: [],
  colors: ["siyah"],
  size: null,
  priceMin: null,
  priceMax: 2500,
  attributes: {},
  sort: null,
};

const ALL_COPY: string[] = [
  ...(Object.values(CHAT_COPY).filter((v) => typeof v === "string") as string[]),
  CHAT_COPY.brandExcludeUnresolved("Nike"),
  CHAT_COPY.seeAllCount(75),
  ...["color", "size", "category", "typo", "alias", "token:kırmızı"].map(
    (r) => relaxationLabel(r) ?? "",
  ),
  ...Object.values(CHAT_ERROR_COPY).map((entry) => entry.message),
];

const COMPOSER_STAYS_OPEN = new Set([
  "invalid_input",
  "invalid_type",
  "too_large",
  "unprocessable",
  "send_failed",
]);

describe("chat copy (CLAUDE.md dil kuralları)", () => {
  it("has no forbidden words", () => {
    for (const text of ALL_COPY) {
      expect(text).not.toMatch(/satın al|dupe|ucuz/i);
    }
  });

  it("has no ALL CAPS words", () => {
    for (const text of ALL_COPY) {
      expect(text).not.toMatch(/\p{Lu}{3,}/u);
    }
  });

  it("every error kind offers a way forward", () => {
    for (const [kind, copy] of Object.entries(CHAT_ERROR_COPY)) {
      // Bu türlerde giriş kutusu açık kalır ve mesaj ile fotoğraf korunur: kullanıcı yazıyı ya da
      // fotoğrafı düzeltip yeniden gönderir (karar 0080). Ayrı bir düğmeye gerek yoktur.
      if (COMPOSER_STAYS_OPEN.has(kind)) continue;
      expect(copy.retry || copy.searchDirectly || copy.newChat).toBe(true);
    }
  });
});

describe("errorKindForStatus", () => {
  it("treats success statuses as no error", () => {
    for (const status of ["queued", "duplicate", "answered", "idle"]) {
      expect(errorKindForStatus(status)).toBeNull();
    }
  });

  it("maps failures to UI errors and unknown statuses to a safe default", () => {
    expect(errorKindForStatus("provider_error")).toBe("provider");
    expect(errorKindForStatus("rate_limited")).toBe("rate_limited");
    expect(errorKindForStatus("conversation_full")).toBe("conversation_full");
    expect(errorKindForStatus("something-new")).toBe("provider");
  });
});

describe("fullResultsHref", () => {
  it("hands the intent back to /ara in a form the existing parser understands", () => {
    const href = fullResultsHref(INTENT);
    const q = new URL(href, "https://x.test").searchParams.get("q");
    expect(href.startsWith("/ara?q=")).toBe(true);
    expect(q).toBe("günlük spor ayakkabı Nike siyah 2500 tl altı");
  });

  it("encodes a price range", () => {
    const q = new URL(
      fullResultsHref({ ...INTENT, priceMin: 1000 }),
      "https://x.test",
    ).searchParams.get("q");
    expect(q).toContain("1000-2500 arası");
  });
});

describe("ChatResultGrid", () => {
  it("renders the shared ProductCard with real product links", () => {
    const html = renderToStaticMarkup(
      createElement(ChatResultGrid, {
        labelledBy: "h",
        items: [
          {
            productId: 7,
            slug: "nike-pegasus",
            title: "Nike Pegasus",
            primaryImageUrl: null,
            minPrice: 450_000,
            offerCount: 2,
            brandName: "Nike",
          },
        ],
      }),
    );
    expect(html).toContain('href="/urun/nike-pegasus"');
    expect(html).toContain("Nike Pegasus");
    expect(html).toContain("2 mağaza");
  });
});

describe("ChatThread", () => {
  const messages: ChatMessageView[] = [
    { id: 1, seq: 1, role: "user", kind: "text", content: "ayakkabı arıyorum", value: null },
    {
      id: 2,
      seq: 2,
      role: "assistant",
      kind: "clarify",
      content: "Ne tür ayakkabı arıyorsun?",
      question: null,
    },
    { id: 3, seq: 3, role: "user", kind: "option", content: "Koşu", value: "running" },
    { id: 4, seq: 4, role: "user", kind: "skip", content: "Atla", value: null },
  ];

  it("renders user messages on the right and assistant messages on the left, in order", () => {
    const html = renderToStaticMarkup(createElement(ChatThread, { messages, conversationId: "c" }));
    expect(html.indexOf("ayakkabı arıyorum")).toBeLessThan(
      html.indexOf("Ne tür ayakkabı arıyorsun?"),
    );
    expect(html.indexOf("Ne tür ayakkabı arıyorsun?")).toBeLessThan(html.indexOf("Koşu"));
    expect(html).toContain("rowUser");
    expect(html).toContain("rowAssistant");
    expect(html).toContain(CHAT_COPY.skippedAnswer);
  });

  it("escapes message content (no HTML injection from user or model text)", () => {
    const html = renderToStaticMarkup(
      createElement(ChatThread, {
        conversationId: "c",
        messages: [
          {
            id: 1,
            seq: 1,
            role: "user",
            kind: "text",
            content: "<img src=x onerror=alert(1)>",
            value: null,
          },
        ],
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
