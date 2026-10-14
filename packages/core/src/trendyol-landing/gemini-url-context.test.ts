import { describe, expect, it } from "vitest";

import {
  buildRequestBody,
  compareWithTruth,
  contentIdOf,
  freeTierGate,
  geminiKeysFromEnvText,
  parseGenerateContent,
  probe,
} from "./gemini-url-context.ts";
import type { PriceObservation } from "./price-observation.ts";

// SENTETIK: yanit bicimi Gemini generateContent belgesini izler (candidates[0].content.parts,
// urlContextMetadata.urlMetadata, groundingMetadata.groundingChunks, usageMetadata).
// Gercek Gemini yaniti DEGIL; ilk gercek yanitla `shape` uzerinden kontrol edilecek.

const URL_A = "https://www.trendyol.com/apple/iphone-16-pro-128gb-col-titanyum-p-857296094";

function payload(pages: unknown[], status = "URL_RETRIEVAL_STATUS_SUCCESS") {
  return {
    candidates: [
      {
        content: { parts: [{ text: `\`\`\`json\n${JSON.stringify({ pages })}\n\`\`\`` }] },
        finishReason: "STOP",
        urlContextMetadata: { urlMetadata: [{ retrievedUrl: URL_A, urlRetrievalStatus: status }] },
      },
    ],
    usageMetadata: {
      promptTokenCount: 120,
      toolUsePromptTokenCount: 9000,
      candidatesTokenCount: 80,
    },
  };
}

const truth = (kind: PriceObservation["kind"], kurus: number, at: string): PriceObservation => ({
  kind,
  contentId: "857296094",
  barcode: null,
  variant: null,
  supplierId: "724838",
  priceKurus: kurus,
  currency: "TRY",
  observedAt: at,
  source: "browser-product-page",
});

describe("freeTierGate", () => {
  it("bayrak ve anahtar olmadan hazir degil", () => {
    expect(freeTierGate({}, []).ready).toBe(false);
    expect(freeTierGate({ TRENDYOL_GEMINI_FREE_TIER: "1" }, []).ready).toBe(false);
  });
  it("production anahtariyla ayni anahtari reddeder", () => {
    const env = { TRENDYOL_GEMINI_FREE_TIER: "1", GEMINI_FREE_TIER_API_KEY: "abc123" };
    const gate = freeTierGate(env, [" abc123 "]);
    expect(gate.ready).toBe(false);
    expect(gate.apiKey).toBeNull();
    expect(freeTierGate(env, ["other"]).ready).toBe(true);
  });
  it("env metninden yalnizca GEMINI_API_KEY degerlerini okur", () => {
    const text = 'FOO=1\nGEMINI_API_KEY="k1"\n# GEMINI_API_KEY=x\nexport GEMINI_API_KEY=k2\n';
    expect(geminiKeysFromEnvText(text)).toEqual(["k1", "k2"]);
  });
});

describe("istek govdesi", () => {
  it("url_context kipinde yalnizca URL Context araci var", () => {
    const body = JSON.parse(buildRequestBody("url_context", "p"));
    expect(body.tools).toEqual([{ url_context: {} }]);
    const both = JSON.parse(buildRequestBody("search_and_url_context", "p"));
    expect(both.tools).toEqual([{ google_search: {} }, { url_context: {} }]);
  });
});

describe("parseGenerateContent", () => {
  it("fiyat, kanit tutarliligi, okuma durumu ve token sayilarini ayiklar", () => {
    const r = parseGenerateContent(
      payload([
        {
          url: URL_A,
          title: "iPhone 16 Pro",
          seller: "Akarsu İletişim",
          price: { amount: 124999, currency: "TRY", evidence: "124.999 TL" },
          originalPrice: { amount: 127999, evidence: "127.999 TL" },
          inStock: true,
          variant: "Çöl Titanyum",
        },
      ]),
    );
    expect(r.ok).toBe(true);
    expect(r.retrieved).toEqual([{ url: URL_A, status: "URL_RETRIEVAL_STATUS_SUCCESS" }]);
    expect(r.pages[0]?.priceKurus).toBe(12_499_900);
    expect(r.pages[0]?.evidenceConsistent).toBe(true);
    expect(r.pages[0]?.originalPriceKurus).toBe(12_799_900);
    expect(r.tokens).toEqual({ prompt: 120, toolUse: 9000, output: 80 });
  });
  it("kanit metni tutari icermiyorsa tutarsiz isaretlenir", () => {
    const r = parseGenerateContent(
      payload([{ url: URL_A, price: { amount: 99999, currency: "TRY", evidence: "124.999 TL" } }]),
    );
    expect(r.pages[0]?.evidenceConsistent).toBe(false);
  });
  it("bicimsiz yanit ve bos metin basarisizdir", () => {
    expect(parseGenerateContent(null).ok).toBe(false);
    expect(
      parseGenerateContent({ candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] })
        .failure,
    ).toBe("empty_text:SAFETY");
  });
});

describe("probe", () => {
  it("HTTP hatasi kodla doner, yeniden denemez", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response("{}", { status: 429 });
    }) as unknown as typeof fetch;
    const r = await probe("k", "url_context", { url: URL_A }, f);
    expect(r.failure).toBe("http_429");
    expect(calls).toBe(1);
  });
});

describe("compareWithTruth", () => {
  const probedAt = "2026-10-15T10:00:00Z";
  const ok = parseGenerateContent(
    payload([
      {
        url: URL_A,
        seller: "Akarsu İletişim",
        price: { amount: 124999, currency: "TRY", evidence: "124.999 TL" },
      },
    ]),
  );
  it("ayni dakikalardaki sayfa gozlemiyle esitlik katmanini bulur", () => {
    const c = compareWithTruth(
      "857296094",
      { ...ok, httpStatus: 200, latencyMs: 1 },
      probedAt,
      [
        truth("page.discounted", 12_499_900, "2026-10-15T10:03:00Z"),
        truth("page.original", 12_799_900, "2026-10-15T10:03:00Z"),
      ],
      "Akarsu Iletisim",
    );
    expect(c.retrievedOk).toBe(true);
    expect(c.matchedKinds).toEqual(["page.discounted"]);
    expect(c.matchesDisplayed).toBe(true);
    expect(c.sellerMatches).toBe(true);
  });
  it("pencere disindaki yer gercegiyle karsilastirmaz", () => {
    const c = compareWithTruth(
      "857296094",
      { ...ok, httpStatus: 200, latencyMs: 1 },
      probedAt,
      [truth("page.discounted", 12_499_900, "2026-10-11T23:23:29Z")],
      null,
    );
    expect(c.truthAvailable).toBe(false);
    expect(c.matchesDisplayed).toBeNull();
  });
  it("contentId yalnizca www.trendyol.com https adreslerinden okunur", () => {
    expect(contentIdOf(URL_A)).toBe("857296094");
    expect(contentIdOf("https://www.trendyol.com/x/y-p-12?merchantId=1")).toBe("12");
    expect(contentIdOf("https://evil.example/x-p-12")).toBeNull();
    expect(contentIdOf("http://www.trendyol.com/x-p-12")).toBeNull();
  });
});
