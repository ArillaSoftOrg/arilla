import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReferralLinkClient } from "./referral-link-client.tsx";

describe("ReferralLinkClient (karar 0067)", () => {
  const html = renderToStaticMarkup(
    createElement(ReferralLinkClient, {
      url: "https://manicepte.com/davet/YS-49577",
      display: "manicepte.com/davet/YS-49577",
    }),
  );

  it("etiketi, şemasız bağlantıyı ve kopyalama düğmesini gösterir", () => {
    expect(html).toContain("Yönlendirme bağlantınız");
    expect(html).toContain("manicepte.com/davet/YS-49577");
    expect(html).not.toContain("https://manicepte.com/davet");
    expect(html).toContain("Panoya kopyala");
    expect(html).not.toContain("Kopyalandı");
  });

  it("ödül metni, sayaç ve hak/limit ifadesi içermez; ALL CAPS yok", () => {
    for (const forbidden of ["bonus", "ödül", "hak", "limit", "bekliyor"]) {
      expect(html.toLowerCase()).not.toContain(forbidden);
    }
    expect(html).not.toContain("PANOYA KOPYALA");
  });
});
