import { CHAT_IMAGE_CONSENT_VERSION } from "@arilla/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { outcomeForNewChat } from "../home-image-chat.ts";
import { CHAT_ERROR_COPY, errorKindForStatus } from "./chat-copy.ts";
import { ChatImageConsentDialog } from "./chat-image-consent.tsx";
import { CHAT_IMAGE_CONSENT_COPY as COPY } from "./chat-image-consent-copy.ts";

const noop = () => {};
const render = (props: { pending?: boolean; error?: boolean } = {}) =>
  renderToStaticMarkup(
    createElement(ChatImageConsentDialog, {
      open: true,
      pending: props.pending ?? false,
      error: props.error ?? false,
      onAccept: noop,
      onDecline: noop,
    }),
  );

describe("fotoğraf izni penceresi (karar 0101)", () => {
  it("onay kutusu yok, önceden işaretli hiçbir şey yok; kabul ve ret ayrı düğmeler", () => {
    const html = render();
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("checked");
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain(COPY.accept);
    expect(html).toContain(COPY.decline);
  });

  it("kabul ve ret aynı görsel sınıfı taşır (biri öne çıkarılmaz)", () => {
    const classes = [...render().matchAll(/<button[^>]*class="([^"]+)"/g)].map((m) => m[1]);
    expect(classes).toHaveLength(2);
    expect(new Set(classes).size).toBe(1);
  });

  it("bilgilendirme: Gemini, yurt dışı, 90 gün, geri çekme ve aydınlatma bağlantısı", () => {
    const html = render();
    expect(html).toContain("Gemini");
    expect(html).toContain("yurt dışına");
    expect(html).toContain("90 gün");
    expect(html).toContain("geri çekebilirsin");
    expect(html).toContain(`href="${COPY.detailsHref}"`);
  });

  it("doğrulanmamış hukuki beyan içermez (model eğitimi, saklama süresi taahhüdü, sözleşme)", () => {
    const all = JSON.stringify(COPY);
    expect(all).not.toMatch(/eğitim|sözleşme|güvenli bir şekilde|asla|garanti/i);
  });

  it("ALL CAPS ve yasak sözcük yok (CLAUDE.md dil kuralları)", () => {
    const all = JSON.stringify(COPY);
    expect(all.replaceAll("KVKK", "")).not.toMatch(/\b\p{Lu}{4,}\b/u);
    expect(all).not.toMatch(/satın al|dupe|ucuz/i);
  });

  it("hata gösterilir", () => {
    expect(render({ error: true })).toContain(COPY.saveError);
    expect(render()).not.toContain(COPY.saveError);
  });

  it("metin sürümü sabittir ve tarih içerir (metin değişince birlikte güncellenir)", () => {
    expect(CHAT_IMAGE_CONSENT_VERSION).toMatch(/^chat-image-\d{4}-\d{2}-\d{2}$/);
  });
});

describe("consent_required durumu", () => {
  it("sohbet içinde ve ana sayfa yolunda anlaşılır hataya çevrilir, yeniden denemeyle geçilmez", () => {
    expect(errorKindForStatus("consent_required")).toBe("consent_required");
    expect(CHAT_ERROR_COPY.consent_required.retry).toBe(false);
    const outcome = outcomeForNewChat({ status: "consent_required" });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.retry).toBe(false);
  });
});
