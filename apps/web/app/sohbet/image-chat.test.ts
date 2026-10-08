import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifySession: vi.fn(),
  createConversation: vi.fn(),
  processPendingTurn: vi.fn(),
  getChatInterpreter: vi.fn(),
  prepareChatImage: vi.fn(),
  submitUserMessage: vi.fn(),
  loadChatAttachment: vi.fn(),
  after: vi.fn(),
  enabled: vi.fn(() => true),
  imageEnabled: vi.fn(() => true),
}));

vi.mock("../lib/dal.ts", () => ({ verifySession: mocks.verifySession }));
vi.mock("@arilla/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@arilla/db")>()),
  getDatabase: () => ({ db: true }),
}));
vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Error(`REDIRECT:${href}`);
  },
}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@arilla/core", async () => {
  const actual = await vi.importActual<typeof import("@arilla/core")>("@arilla/core");
  return {
    ...actual,
    isChatDiscoveryEnabled: mocks.enabled,
    isChatImageEnabled: mocks.imageEnabled,
    canAccessProduct: () => true,
    createConversation: mocks.createConversation,
    processPendingTurn: mocks.processPendingTurn,
    getChatInterpreter: mocks.getChatInterpreter,
    prepareChatImage: mocks.prepareChatImage,
    submitUserMessage: mocks.submitUserMessage,
    loadChatAttachment: mocks.loadChatAttachment,
  };
});

import { isImeEnter, SearchComposer } from "@arilla/ui";
import {
  IMAGE_CHAT_COPY,
  IMAGE_CHAT_ERROR_COPY,
  outcomeForNewChat,
  validateAttachmentFile,
} from "../home-image-chat.ts";
import { sendMessageAction, startChatBootstrapAction } from "./actions.ts";
import { ChatUserRow } from "./chat-shell-parts.tsx";
import { GET } from "./gorsel/[attachmentId]/route.ts";

const USER = { id: 7 };
const ID = "11111111-1111-4111-8111-111111111111";
const KEY = "req-key-12345678";
const PREPARED = {
  bytes: Buffer.from([1, 2, 3]),
  mimeType: "image/jpeg" as const,
  width: 10,
  height: 8,
};
const READY = { ok: true as const, attachment: PREPARED };

function form(options: { text?: string; file?: File | null; key?: string | null } = {}): FormData {
  const data = new FormData();
  const file =
    options.file === undefined
      ? new File([new Uint8Array([1, 2, 3])], "a.jpg", { type: "image/jpeg" })
      : options.file;
  if (file) data.set("photo", file);
  if (options.text !== undefined) data.set("q", options.text);
  if (options.key !== null) data.set("requestKey", options.key ?? KEY);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.imageEnabled.mockReturnValue(true);
  mocks.verifySession.mockResolvedValue(USER);
  mocks.createConversation.mockResolvedValue({ status: "created", conversationId: ID });
  mocks.getChatInterpreter.mockReturnValue({ modelVersion: "m" });
  mocks.prepareChatImage.mockResolvedValue(READY);
  mocks.submitUserMessage.mockResolvedValue({ status: "queued", seq: 3 });
});

describe("startChatBootstrapAction: görsel normal mesajın ekidir (karar 0079)", () => {
  it("görsel + metin TEK createConversation çağrısı; ilk tur after() ile bir kez planlanır", async () => {
    const result = await startChatBootstrapAction(form({ text: "  Bunun siyahını bul " }));
    expect(result).toEqual({ status: "created", href: `/sohbet/${ID}` });
    expect(mocks.createConversation).toHaveBeenCalledTimes(1);
    expect(mocks.createConversation).toHaveBeenCalledWith(
      { db: true },
      { userId: 7, message: "Bunun siyahını bul", requestKey: KEY, attachment: PREPARED },
    );
    expect(mocks.after).toHaveBeenCalledTimes(1);
    // Yanıt Gemini'yi beklemez.
    expect(mocks.processPendingTurn).not.toHaveBeenCalled();
  });

  it("yalnız görsel: boş metinle, yine tek mesaj", async () => {
    const result = await startChatBootstrapAction(form());
    expect(result.status).toBe("created");
    expect(mocks.createConversation).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ message: "", attachment: PREPARED }),
    );
  });

  it("metin-only çağrı görselsiz aynı hattan geçer: ek anahtarı ve anahtar yok", async () => {
    await startChatBootstrapAction("beyaz sneaker");
    expect(mocks.createConversation).toHaveBeenCalledWith(
      { db: true },
      { userId: 7, message: "beyaz sneaker" },
    );
    expect(mocks.prepareChatImage).not.toHaveBeenCalled();
  });

  it("after() işi mevcut kira yolunu (processPendingTurn) tam bir kez kullanır", async () => {
    await startChatBootstrapAction(form());
    const task = mocks.after.mock.calls[0]?.[0] as () => Promise<void>;
    await task();
    expect(mocks.processPendingTurn).toHaveBeenCalledTimes(1);
  });

  it("metin 500 karaktere kırpılır", async () => {
    await startChatBootstrapAction(form({ text: "a".repeat(900) }));
    const call = mocks.createConversation.mock.calls[0]?.[1] as { message: string };
    expect(call.message).toHaveLength(500);
  });

  it("bayrak kapalıyken hiçbir şey okunmaz/yazılır ve ESKİ ARAMAYA DÜŞÜLMEZ", async () => {
    mocks.imageEnabled.mockReturnValue(false);
    expect(await startChatBootstrapAction(form({ text: "bu" }))).toEqual({ status: "unavailable" });
    mocks.imageEnabled.mockReturnValue(true);
    mocks.enabled.mockReturnValue(false);
    expect(await startChatBootstrapAction(form({ text: "bu" }))).toEqual({ status: "unavailable" });
    expect(mocks.prepareChatImage).not.toHaveBeenCalled();
    expect(mocks.createConversation).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("oturum yoksa login_required (görselde /ara yedeği yok)", async () => {
    mocks.verifySession.mockResolvedValue(null);
    expect(await startChatBootstrapAction(form())).toEqual({ status: "login_required" });
    expect(mocks.createConversation).not.toHaveBeenCalled();
  });

  it("geçersiz istek anahtarı: görsel gönderilmez", async () => {
    expect(await startChatBootstrapAction(form({ key: null }))).toEqual({
      status: "image_rejected",
      reason: "invalid_input",
    });
    expect(mocks.createConversation).not.toHaveBeenCalled();
  });

  it("çekirdek doğrulama reddederse kullanıcıya sabit kod; sohbet açılmaz", async () => {
    for (const reason of ["invalid_type", "too_large", "unprocessable", "invalid_input"] as const) {
      mocks.prepareChatImage.mockResolvedValueOnce({ ok: false, status: reason });
      expect(await startChatBootstrapAction(form())).toEqual({ status: "image_rejected", reason });
    }
    mocks.prepareChatImage.mockResolvedValueOnce({ ok: false, status: "error" });
    expect(await startChatBootstrapAction(form())).toEqual({ status: "error" });
    expect(mocks.createConversation).not.toHaveBeenCalled();
  });

  it("saatlik tavan görselde rate_limited (/ara yedeği yok); veritabanı hatası sabit koddur", async () => {
    mocks.createConversation.mockResolvedValueOnce({ status: "rate_limited" });
    expect(await startChatBootstrapAction(form())).toEqual({ status: "rate_limited" });
    mocks.createConversation.mockRejectedValueOnce(new Error("secret detail"));
    expect(await startChatBootstrapAction(form())).toEqual({ status: "error" });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("aynı requestKey ile ikinci çağrı createConversation'a aynı anahtarla gider (sunucu tekilleştirir)", async () => {
    await startChatBootstrapAction(form());
    await startChatBootstrapAction(form());
    const keys = mocks.createConversation.mock.calls.map(
      (call) => (call[1] as { requestKey: string }).requestKey,
    );
    expect(keys).toEqual([KEY, KEY]);
  });
});

describe("sendMessageAction: sohbet içinden görsel aynı konuşmaya eklenir", () => {
  const photo = () => {
    const data = new FormData();
    data.set("photo", new File([new Uint8Array([1, 2, 3])], "a.jpg", { type: "image/jpeg" }));
    return data;
  };
  const TEXT = { kind: "text", text: "buna benzer beyaz olsun" };

  it("metin + görsel TEK submitUserMessage çağrısı, aynı konuşma, ek ile", async () => {
    const result = await sendMessageAction(ID, TEXT, KEY, photo());
    expect(result).toEqual({ status: "queued" });
    expect(mocks.submitUserMessage).toHaveBeenCalledTimes(1);
    expect(mocks.submitUserMessage).toHaveBeenCalledWith(
      { db: true },
      {
        userId: 7,
        conversationId: ID,
        request: { kind: "text", text: "buna benzer beyaz olsun" },
        requestKey: KEY,
        attachment: PREPARED,
      },
    );
    // Yeni sohbet açılmaz.
    expect(mocks.createConversation).not.toHaveBeenCalled();
  });

  it("yalnız görsel: boş metinle aynı çağrı", async () => {
    await sendMessageAction(ID, { kind: "text", text: "" }, KEY, photo());
    expect(mocks.submitUserMessage).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ request: { kind: "text", text: "" }, attachment: PREPARED }),
    );
  });

  it("görselsiz mesajda çağrı biçimi eskisi gibi (ek anahtarı yok)", async () => {
    await sendMessageAction(ID, TEXT, KEY);
    const call = mocks.submitUserMessage.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(call).not.toHaveProperty("attachment");
    expect(mocks.prepareChatImage).not.toHaveBeenCalled();
  });

  it("CHAT_IMAGE_ENABLED kapalıysa görsel işlenmez ve mesaj yazılmaz", async () => {
    mocks.imageEnabled.mockReturnValue(false);
    expect(await sendMessageAction(ID, TEXT, KEY, photo())).toEqual({ status: "unavailable" });
    expect(mocks.prepareChatImage).not.toHaveBeenCalled();
    expect(mocks.submitUserMessage).not.toHaveBeenCalled();
  });

  it("görsel doğrulaması başarısızsa mesaj yazılmaz ve sabit kod döner", async () => {
    for (const status of ["invalid_type", "too_large", "unprocessable", "invalid_input"] as const) {
      mocks.prepareChatImage.mockResolvedValueOnce({ ok: false, status });
      expect(await sendMessageAction(ID, TEXT, KEY, photo())).toEqual({ status });
    }
    expect(mocks.submitUserMessage).not.toHaveBeenCalled();
  });

  it("görsel alanı olmayan FormData geçersiz girdi sayılır", async () => {
    mocks.prepareChatImage.mockResolvedValueOnce({ ok: false, status: "invalid_input" });
    expect(await sendMessageAction(ID, TEXT, KEY, new FormData())).toEqual({
      status: "invalid_input",
    });
    expect(mocks.prepareChatImage).toHaveBeenCalledWith(null);
  });

  it("çekirdeğin durumları aynen iletilir: image_limit, busy, duplicate, rate_limited", async () => {
    for (const status of ["image_limit", "busy", "duplicate", "rate_limited"] as const) {
      mocks.submitUserMessage.mockResolvedValueOnce({ status });
      expect(await sendMessageAction(ID, TEXT, KEY, photo())).toEqual({ status });
    }
  });

  it("görselli gönderimde veritabanı hatası sabit koddur; metin yolu hatayı eskisi gibi iletir", async () => {
    mocks.submitUserMessage.mockRejectedValueOnce(new Error("secret detail"));
    expect(await sendMessageAction(ID, TEXT, KEY, photo())).toEqual({ status: "error" });
    mocks.submitUserMessage.mockRejectedValueOnce(new Error("boom"));
    await expect(sendMessageAction(ID, TEXT, KEY)).rejects.toThrow("boom");
  });

  it("oturum yok ya da sohbet kapalı: hiçbir şey işlenmez", async () => {
    mocks.verifySession.mockResolvedValueOnce(null);
    expect(await sendMessageAction(ID, TEXT, KEY, photo())).toEqual({ status: "unavailable" });
    mocks.enabled.mockReturnValueOnce(false);
    expect(await sendMessageAction(ID, TEXT, KEY, photo())).toEqual({ status: "unavailable" });
    expect(mocks.prepareChatImage).not.toHaveBeenCalled();
  });
});

describe("home-image-chat (saf mantık)", () => {
  it("dosya doğrulaması: tür ve boyut", () => {
    expect(validateAttachmentFile({ type: "image/png", size: 1000 })).toBeNull();
    expect(validateAttachmentFile({ type: "application/pdf", size: 1000 })).toBe("invalid_type");
    expect(validateAttachmentFile({ type: "image/jpeg", size: 0 })).toBe("invalid_type");
    expect(validateAttachmentFile({ type: "image/jpeg", size: 5 * 1024 * 1024 })).toBe("too_large");
  });

  it("sonuç -> yönlendirme / giriş / hata metni; görselde /ara yedeği hiç üretilmez", () => {
    expect(outcomeForNewChat({ status: "created", href: "/sohbet/x" })).toEqual({
      kind: "navigate",
      href: "/sohbet/x",
    });
    expect(outcomeForNewChat({ status: "login_required" })).toEqual({ kind: "login" });
    expect(outcomeForNewChat({ status: "image_rejected", reason: "too_large" })).toEqual({
      kind: "error",
      message: IMAGE_CHAT_ERROR_COPY.too_large,
      retry: false,
    });
    expect(outcomeForNewChat({ status: "rate_limited" })).toEqual({
      kind: "error",
      message: IMAGE_CHAT_ERROR_COPY.rate_limited,
      retry: true,
    });
    expect(outcomeForNewChat({ status: "unavailable" })).toMatchObject({
      kind: "error",
      retry: false,
    });
    expect(outcomeForNewChat({ status: "error" })).toMatchObject({ kind: "error", retry: true });
    // Metin mesajının yedeği (yapay zekasız arama) bu şekilde kalır.
    expect(outcomeForNewChat({ status: "fallback", href: "/ara?q=x" })).toEqual({
      kind: "fallback",
      href: "/ara?q=x",
    });
  });

  it("arayüz metinlerinde yasak sözcük ve BÜYÜK HARF yok", () => {
    const text = [...Object.values(IMAGE_CHAT_COPY), ...Object.values(IMAGE_CHAT_ERROR_COPY)].join(
      " ",
    );
    expect(text).not.toMatch(/satın al|dupe|ucuz/i);
    expect(text).not.toMatch(/\p{Lu}{3,}/u);
  });
});

describe("SearchComposer: bekleyen fotoğraf", () => {
  const base = { placeholder: "Ara", submitLabel: "Gönder" };

  function markup(attachment?: Parameters<typeof SearchComposer>[0]["attachment"]) {
    return renderToStaticMarkup(createElement(SearchComposer, { ...base, attachment }));
  }

  it("fotoğraf yokken önizleme/kaldır düğmesi yok (mevcut görünüm)", () => {
    const html = markup(null);
    expect(html).not.toContain("Fotoğrafı kaldır");
    expect(html).toContain('enterKeyHint="search"');
  });

  it("fotoğraf seçilince önizleme + kaldır düğmesi + gönder ipucu görünür", () => {
    const html = markup({
      previewUrl: "blob:x",
      alt: IMAGE_CHAT_COPY.previewAlt,
      removeLabel: IMAGE_CHAT_COPY.removeLabel,
      onRemove: () => undefined,
      onSubmit: () => true,
    });
    expect(html).toContain('src="blob:x"');
    expect(html).toContain(`alt="${IMAGE_CHAT_COPY.previewAlt}"`);
    expect(html).toContain(`aria-label="${IMAGE_CHAT_COPY.removeLabel}"`);
    expect(html).toContain('enterKeyHint="send"');
  });

  it("gönderim sürerken kaldır, girdi ve gönder kapalı; form meşgul", () => {
    const html = markup({
      previewUrl: "blob:x",
      alt: "a",
      removeLabel: "Kaldır",
      onRemove: () => undefined,
      onSubmit: () => true,
      pending: true,
    });
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/aria-label="Kaldır"[^>]*disabled/);
    expect(html).toContain("readOnly");
  });

  it("Enter/IME: yalnızca birleştirme onayı Enter'ı bastırılır; Shift+Enter ve normal Enter değil", () => {
    expect(isImeEnter({ key: "Enter", isComposing: true })).toBe(true);
    expect(isImeEnter({ key: "Enter", keyCode: 229 })).toBe(true);
    expect(isImeEnter({ key: "Enter", isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeEnter({ key: "a", isComposing: true })).toBe(false);
  });
});

describe("sohbet geçmişinde kullanıcı mesajı", () => {
  it("görsel + metin aynı balonda, tek öğe", () => {
    const html = renderToStaticMarkup(
      createElement(ChatUserRow, { text: "Bunun siyahını bul", imageSrc: `/sohbet/gorsel/${ID}` }),
    );
    expect(html.match(/<li[ >]/g)).toHaveLength(1);
    expect(html).toContain(`src="/sohbet/gorsel/${ID}"`);
    expect(html).toContain("Bunun siyahını bul");
  });

  it("yalnız görsel: metin paragrafı yok", () => {
    const html = renderToStaticMarkup(
      createElement(ChatUserRow, { text: "", imageSrc: `/sohbet/gorsel/${ID}` }),
    );
    expect(html).toContain("<img");
    expect(html).not.toContain("<p");
  });

  it("metin-only mesaj eskisi gibi (görsel yok)", () => {
    const html = renderToStaticMarkup(createElement(ChatUserRow, { text: "siyah ayakkabı" }));
    expect(html).not.toContain("<img");
    expect(html).toContain("siyah ayakkabı");
  });
});

describe("GET /sohbet/gorsel/[id]", () => {
  const params = (id: string) => ({ params: Promise.resolve({ attachmentId: id }) });

  it("sahibine bayt döner; önbelleğe girmez", async () => {
    mocks.loadChatAttachment.mockResolvedValue({
      mimeType: "image/jpeg",
      data: Buffer.from([9, 9]),
    });
    const response = await GET(new Request("http://x"), params(ID));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.loadChatAttachment).toHaveBeenCalledWith(
      { db: true },
      { userId: 7, attachmentId: ID },
    );
  });

  it("oturum yok, kapalı özellik, geçersiz kimlik ya da başkasının eki: aynı 404", async () => {
    mocks.verifySession.mockResolvedValueOnce(null);
    expect((await GET(new Request("http://x"), params(ID))).status).toBe(404);
    mocks.enabled.mockReturnValueOnce(false);
    expect((await GET(new Request("http://x"), params(ID))).status).toBe(404);
    expect((await GET(new Request("http://x"), params("nope"))).status).toBe(404);
    mocks.loadChatAttachment.mockResolvedValue(null);
    expect((await GET(new Request("http://x"), params(ID))).status).toBe(404);
  });
});
