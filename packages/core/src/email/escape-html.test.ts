import { describe, expect, it } from "vitest";
import { buildAlertEmail } from "../account/send-alert-email.ts";
import { buildLoginEmail } from "../auth/send-login-email.ts";
import { escapeHtml } from "./escape-html.ts";

describe("escapeHtml", () => {
  it("escapes all HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("leaves plain Turkish text untouched", () => {
    expect(escapeHtml("Işıklı çanta İstanbul ğüşöç")).toBe("Işıklı çanta İstanbul ğüşöç");
  });
});

describe("email bodies", () => {
  it("escapes product title and size in alert HTML", () => {
    const mail = buildAlertEmail({
      kind: "size_restock",
      productTitle: `<img src=x onerror="alert(1)">`,
      productUrl: "https://arilla.example/urun/a?b=1&c=2",
      sizeNorm: "<b>M</b>",
    });
    expect(mail.html).not.toContain("<img");
    expect(mail.html).not.toContain("<b>");
    expect(mail.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(mail.html).toContain('href="https://arilla.example/urun/a?b=1&amp;c=2"');
    // Duz metin govde HTML degil; ham kalir.
    expect(mail.text).toContain(`<img src=x onerror="alert(1)">`);
  });

  it("escapes the login URL in HTML", () => {
    const mail = buildLoginEmail(`https://arilla.example/giris/dogrula?token=a"b`);
    expect(mail.html).toContain('href="https://arilla.example/giris/dogrula?token=a&quot;b"');
    expect(mail.subject).toBe("Giriş bağlantın");
  });
});
