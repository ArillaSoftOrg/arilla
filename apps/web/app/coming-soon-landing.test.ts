import { EARLY_ACCESS_LOGIN_PATH, EARLY_ACCESS_PATH } from "@arilla/core";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./public-site-shell.tsx", () => ({
  PublicSiteShell: ({ children }: { children: ReactNode }) => children,
}));

import { ComingSoonLanding } from "./coming-soon-landing.tsx";

describe("prelaunch mascot story", () => {
  it("keeps enrollment links and all story content usable without client JavaScript", () => {
    const html = renderToStaticMarkup(createElement(ComingSoonLanding, { signedIn: false }));
    expect(html).toContain(`href="${EARLY_ACCESS_LOGIN_PATH}"`);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html.match(/data-mascot-guide=""/g)).toHaveLength(2);
    expect(html).toContain("robot-welcome.png");
    expect(html).toContain("robot-social-point-v2.png");
    expect(html).toContain("Tarif et");
    expect(html).toContain("Fotoğraf göster");
    expect(html).toContain("Link bırak");
    expect(html).toContain("Temsili önizleme");
    expect(html).toContain("ManiCepte seçenekleri bulup karşılaştırsın.");
    expect(html).toContain("En iyi fiyat-kalite dengesi");
    expect(html).toContain("ManiCepte ürün araştırma akışı");
    expect(html).toContain("Şu an erken erişimdeyiz, ManiCepte’yi geliştirmeye devam ediyoruz.");
    expect(html).toContain("Bilgilerin yalnızca erişim listesi için kullanılır.");
    expect(html).toContain("Henüz kullanıma açık değil");
    expect(html).toContain('href="#nasil-calisacak"');
    expect(html).toContain('id="nasil-calisacak"');
    expect(html.match(/<details\b/g)).toHaveLength(5);
    expect(html).toContain("ManiCepte ne yapar?");
    expect(html).not.toContain("Hareket");
    expect(html).not.toMatch(
      /<video|<form|hero-intro\.mp4|robot-idle|robot-wave|robot-body|data-mascot-stop|data-welcoming/,
    );
  });

  it("takes enrolled visitors to their status without offering to enroll again", () => {
    const html = renderToStaticMarkup(createElement(ComingSoonLanding, { signedIn: true }));
    expect(html).toContain(`href="${EARLY_ACCESS_PATH}"`);
    expect(html).not.toContain(`href="${EARLY_ACCESS_LOGIN_PATH}"`);
    expect(html).toContain("Listedesin. İyi ki geldin.");
  });

  it("shows only the supplied real progress and omits the counter when unavailable", () => {
    const html = renderToStaticMarkup(
      createElement(ComingSoonLanding, {
        signedIn: false,
        progress: { count: 125, target: 5000, percent: 2.5 },
      }),
    );
    expect(html).toContain('aria-valuenow="125"');
    expect(html).toContain('aria-valuemax="5000"');
    const hero = html.slice(html.indexOf("<section"), html.indexOf("</section>"));
    expect(hero).toContain('role="progressbar"');
    expect(hero).toContain('data-prominent="true"');
    expect(hero).toContain("İlk 5.000 kişiden biri ol.");
    expect(hero).toContain("gerçek kayıtlarla güncelleniyor");
    expect(html.match(/role="progressbar"/g)).toHaveLength(1);
    const withoutProgress = renderToStaticMarkup(
      createElement(ComingSoonLanding, { signedIn: false }),
    );
    expect(withoutProgress).not.toContain('role="progressbar"');
  });

  it("derives the hero goal from the supplied target", () => {
    const html = renderToStaticMarkup(
      createElement(ComingSoonLanding, {
        signedIn: false,
        progress: { count: 0, target: 10000, percent: 0 },
      }),
    );
    expect(html).toContain("İlk 10.000 kişiden biri ol.");
  });
});
