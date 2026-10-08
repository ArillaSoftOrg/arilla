import { isSubmitKey, resolveComposerSubmit, SearchComposer } from "@arilla/ui";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));
vi.mock("./actions.ts", () => ({
  startChatBootstrapAction: vi.fn(),
  getTurnStatusAction: vi.fn(),
  runTurnAction: vi.fn(),
  sendMessageAction: vi.fn(),
  submitResultFeedbackAction: vi.fn(),
}));

import { ChatInteractive } from "./chat-client.tsx";
import { CHAT_COPY, CHAT_ERROR_COPY, errorKindForStatus } from "./chat-copy.ts";
import { ChatComposer } from "./chat-shell-parts.tsx";

/** Nitelik sırasından bağımsız: etiketli düğme var mı, kapalı mı? */
function button(html: string, label: string): { exists: boolean; disabled: boolean } {
  const tag = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? null;
  return { exists: tag !== null, disabled: tag?.includes("disabled") ?? false };
}

describe("ortak gönderim semantiği (ana sayfa ve sohbet içi kutu)", () => {
  it("A) yalnız metin gönderir", () => {
    expect(resolveComposerSubmit({ text: "siyah ayakkabı", hasImage: false })).toBe("submit");
  });

  it("B) yalnız görsel (metin yok) gönderir", () => {
    expect(resolveComposerSubmit({ text: "", hasImage: true })).toBe("submit");
    expect(resolveComposerSubmit({ text: "   ", hasImage: true })).toBe("submit");
  });

  it("C) görsel + metin gönderir", () => {
    expect(resolveComposerSubmit({ text: "buna benzer", hasImage: true })).toBe("submit");
  });

  it("D) boş gönderim hiçbir şey yapmaz", () => {
    expect(resolveComposerSubmit({ text: "", hasImage: false })).toBe("noop");
    expect(resolveComposerSubmit({ text: "  \n ", hasImage: false })).toBe("noop");
  });

  it("çift gönderim: meşgulken ikinci Enter/tık hiçbir şey yapmaz", () => {
    expect(resolveComposerSubmit({ text: "x", hasImage: true, busy: true })).toBe("noop");
    expect(resolveComposerSubmit({ text: "", hasImage: true, busy: true })).toBe("noop");
  });

  it("E) Enter gönderir; Shift+Enter yeni satırdır; IME onayı göndermez", () => {
    expect(isSubmitKey({ key: "Enter" })).toBe(true);
    expect(isSubmitKey({ key: "Enter", shiftKey: true })).toBe(false);
    expect(isSubmitKey({ key: "Enter", isComposing: true })).toBe(false);
    expect(isSubmitKey({ key: "Enter", keyCode: 229 })).toBe(false);
    expect(isSubmitKey({ key: "a" })).toBe(false);
  });
});

describe("SearchComposer (ana sayfa): görsel ekleme denetimi yalnızca açıkken var", () => {
  const base = { placeholder: "Ara", submitLabel: "Gönder" };

  it("photo verilmezse (CHAT_IMAGE_ENABLED kapalı / anonim) '+' ve dosya girdisi hiç yok", () => {
    const html = renderToStaticMarkup(createElement(SearchComposer, base));
    expect(html).not.toContain('type="file"');
  });

  it("photo verilirse dosya girdisi ve '+' düğmesi var; seçmek göndermez (form eylemi yok)", () => {
    const html = renderToStaticMarkup(
      createElement(SearchComposer, {
        ...base,
        photo: { label: "Fotoğraf yükle", onFileSelected: () => undefined },
      }),
    );
    expect(html).toContain('type="file"');
    expect(html).toContain('aria-label="Fotoğraf yükle"');
  });
});

describe("ChatComposer (sohbet içi): ek denetimi", () => {
  const render = (props: Parameters<typeof ChatComposer>[0]) =>
    renderToStaticMarkup(createElement(ChatComposer, props));
  const attachment = (previewUrl: string | null) => ({
    previewUrl,
    onFileSelected: () => undefined,
    onRemove: () => undefined,
  });

  it("ek verilmezse '+' yok (bayrak kapalı davranışı eskisi gibi)", () => {
    const html = render({ draft: "", locked: false });
    expect(html).not.toContain('type="file"');
    expect(html).toContain("<textarea");
  });

  it("ek verilirse '+' var; fotoğraf yokken metin yoksa Gönder kapalı", () => {
    const html = render({ draft: "", locked: false, attachment: attachment(null) });
    expect(html).toContain('type="file"');
    expect(html).toContain(`aria-label="${CHAT_COPY.attachLabel}"`);
    expect(button(html, "Gönder")).toEqual({ exists: true, disabled: true });
    expect(html).not.toContain(CHAT_COPY.attachRemoveLabel);
  });

  it("yalnız fotoğraf seçiliyken Gönder açık; önizleme ve kaldır düğmesi görünür", () => {
    const html = render({ draft: "", locked: false, attachment: attachment("blob:x") });
    expect(html).toContain('src="blob:x"');
    expect(html).toContain(`aria-label="${CHAT_COPY.attachRemoveLabel}"`);
    expect(html).toContain(`aria-label="${CHAT_COPY.attachReplaceLabel}"`);
    expect(button(html, "Gönder")).toEqual({ exists: true, disabled: false });
  });

  it("yanıt beklenirken '+' ve kaldır da kilitli", () => {
    const html = render({ draft: "x", locked: true, attachment: attachment("blob:x") });
    expect(button(html, "Fotoğrafı değiştir")).toEqual({ exists: true, disabled: true });
    expect(button(html, "Fotoğrafı kaldır")).toEqual({ exists: true, disabled: true });
  });
});

describe("ChatInteractive: CHAT_IMAGE_ENABLED bayrağı '+' görünürlüğünü belirler", () => {
  const props = {
    conversationId: "11111111-1111-4111-8111-111111111111",
    awaitingReply: false,
    question: null,
    lastUserText: "x",
    lastSeq: 2,
    children: null,
  };

  it("kapalıyken dosya girdisi hiç yok", () => {
    const html = renderToStaticMarkup(
      createElement(ChatInteractive, { ...props, imageEnabled: false }),
    );
    expect(html).not.toContain('type="file"');
  });

  it("açıkken '+' var", () => {
    const html = renderToStaticMarkup(
      createElement(ChatInteractive, { ...props, imageEnabled: true }),
    );
    expect(html).toContain('type="file"');
  });
});

describe("görsel gönderim durumları sohbet içinde anlaşılır hatalara çevrilir", () => {
  it.each([
    ["image_limit", "image_limit"],
    ["invalid_type", "invalid_type"],
    ["too_large", "too_large"],
    ["unprocessable", "unprocessable"],
    ["error", "send_failed"],
  ] as const)("%s -> %s", (status, kind) => {
    expect(errorKindForStatus(status)).toBe(kind);
  });

  it("mesaj ve görsel korunur: tekrar dene düğmesi yok, kullanıcı düzeltip yeniden gönderir", () => {
    for (const kind of ["invalid_type", "too_large", "unprocessable", "send_failed"] as const) {
      expect(CHAT_ERROR_COPY[kind].retry).toBe(false);
      expect(CHAT_ERROR_COPY[kind].searchDirectly).toBe(false);
    }
    expect(CHAT_ERROR_COPY.image_limit.newChat).toBe(true);
  });

  it("yeni metinlerde yasak sözcük ve ALL CAPS yok", () => {
    const text = [
      CHAT_COPY.attachLabel,
      CHAT_COPY.attachReplaceLabel,
      CHAT_COPY.attachRemoveLabel,
      CHAT_COPY.attachPreviewAlt,
      ...Object.values(CHAT_ERROR_COPY).map((entry) => entry.message),
    ].join(" ");
    expect(text).not.toMatch(/satın al|dupe|ucuz/i);
    expect(text.replace(/JPEG|PNG/g, "")).not.toMatch(/\b[A-ZÇĞİÖŞÜ]{4,}\b/);
  });
});
