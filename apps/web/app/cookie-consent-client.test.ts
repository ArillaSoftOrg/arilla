import { type CookieConsent, rejectAll } from "@arilla/core/cookie-consent";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./consent-actions.ts", () => ({
  acceptAllCookiesAction: vi.fn(),
  rejectAllCookiesAction: vi.fn(),
  saveCookiePreferencesAction: vi.fn(),
}));

import { ConsentProvider, useNeedsConsentPrompt } from "./cookie-consent-client.tsx";

function PromptProbe() {
  return createElement("span", { "data-needs-consent": useNeedsConsentPrompt() });
}

function renderProbe(consent: CookieConsent | null) {
  return renderToStaticMarkup(
    createElement(ConsentProvider, {
      consent,
      // biome-ignore lint/correctness/noChildrenProp: createElement types require the provider's required children prop.
      children: createElement(PromptProbe),
    }),
  );
}

describe("presentation consent signal", () => {
  it("waits for a decision on the first visit", () => {
    const html = renderProbe(null);
    expect(html).toContain('data-needs-consent="true"');
  });

  it("continues after rejecting optional cookies, without requiring opt-in", () => {
    const html = renderProbe(rejectAll());
    expect(html).toContain('data-needs-consent="false"');
  });

  it("waits again if the consent policy version changes", () => {
    const html = renderProbe({ ...rejectAll(), version: 1 });
    expect(html).toContain('data-needs-consent="true"');
  });
});
