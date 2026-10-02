import { describe, expect, it } from "vitest";
import {
  bodyToHtml,
  CampaignValidationError,
  renderMarketingEmail,
  TEST_SUBJECT_PREFIX,
  validateCampaignContent,
} from "./content.ts";

const valid = {
  title: "Ekim duyurusu",
  subject: "Yeni özellik",
  body: "Merhaba.\n\nYeni özellik.",
};

describe("validateCampaignContent", () => {
  it("trims and accepts valid content", () => {
    expect(validateCampaignContent({ ...valid, title: "  Ekim  " }).title).toBe("Ekim");
  });

  it("normalizes CRLF in the body", () => {
    expect(validateCampaignContent({ ...valid, body: "a\r\nb" }).body).toBe("a\nb");
  });

  it.each([
    [{ ...valid, title: "" }, "İç ad"],
    [{ ...valid, subject: "   " }, "Konu"],
    [{ ...valid, body: "" }, "İçerik"],
    [{ ...valid, subject: 42 }, "Konu"],
    [{ ...valid, subject: "a".repeat(151) }, "Konu"],
    [{ ...valid, body: "a".repeat(10_001) }, "İçerik"],
  ])("rejects missing/oversized fields %#", (input, label) => {
    expect(() => validateCampaignContent(input)).toThrow(CampaignValidationError);
    expect(() => validateCampaignContent(input)).toThrow(label);
  });

  it("rejects header injection in the subject", () => {
    expect(() => validateCampaignContent({ ...valid, subject: "Merhaba\r\nBcc: x@y.com" })).toThrow(
      CampaignValidationError,
    );
  });

  it("rejects control characters in the body", () => {
    expect(() => validateCampaignContent({ ...valid, body: "a\u0000b" })).toThrow(
      CampaignValidationError,
    );
  });
});

describe("bodyToHtml", () => {
  it("escapes HTML instead of rendering it", () => {
    const html = bodyToHtml('<script>alert(1)</script> <img src=x onerror="y">');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;y&quot;");
  });

  it("builds paragraphs and line breaks", () => {
    expect(bodyToHtml("a\nb\n\nc")).toBe("<p>a<br>b</p>\n<p>c</p>");
  });

  it("links only https URLs and keeps trailing punctuation outside", () => {
    const html = bodyToHtml("Bak: https://manicepte.com/kesfet?a=1&b=2. Eski: http://x.com");
    expect(html).toContain(
      '<a href="https://manicepte.com/kesfet?a=1&amp;b=2">https://manicepte.com/kesfet?a=1&amp;b=2</a>.',
    );
    expect(html).not.toContain('href="http://x.com"');
  });

  it("never links javascript: or quoted payloads", () => {
    const html = bodyToHtml('javascript:alert(1) https://a.com/"onmouseover="x');
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain('"onmouseover="');
    expect(html).toContain('<a href="https://a.com/">');
  });
});

describe("renderMarketingEmail", () => {
  const base = {
    subject: "Yeni özellik",
    body: "Merhaba <b>dünya</b>",
    brand: "ManiCepte",
    appUrl: "https://manicepte.test",
    unsubscribeUrl: "https://manicepte.test/abonelik-iptali?t=abc",
    test: false,
  };

  it("includes the unsubscribe link, account link and reason in html and text", () => {
    const email = renderMarketingEmail(base);
    expect(email.subject).toBe("Yeni özellik");
    expect(email.html).toContain('href="https://manicepte.test/abonelik-iptali?t=abc"');
    expect(email.html).toContain('href="https://manicepte.test/hesap"');
    expect(email.html).toContain("izin verdiğin için aldın");
    expect(email.html).toContain("&lt;b&gt;dünya&lt;/b&gt;");
    expect(email.text).toContain("https://manicepte.test/abonelik-iptali?t=abc");
    expect(email.text).toContain("https://manicepte.test/hesap");
    expect(email.text).toContain("Merhaba <b>dünya</b>");
  });

  it("marks test messages in subject and body", () => {
    const email = renderMarketingEmail({ ...base, unsubscribeUrl: null, test: true });
    expect(email.subject).toBe(`${TEST_SUBJECT_PREFIX}Yeni özellik`);
    expect(email.html).toContain("Bu bir test iletisidir");
    expect(email.text.startsWith("Bu bir test iletisidir")).toBe(true);
    // Kişiye özel token yok.
    expect(email.html).not.toContain("?t=");
  });

  it("uses no hard-coded colours", () => {
    const { html } = renderMarketingEmail(base);
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|color:/i);
  });
});
