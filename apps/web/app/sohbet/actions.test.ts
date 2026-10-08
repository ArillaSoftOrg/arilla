import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifySession: vi.fn(),
  createConversation: vi.fn(),
  processPendingTurn: vi.fn(),
  getChatInterpreter: vi.fn(),
  after: vi.fn(),
  enabled: vi.fn(() => true),
  setResultFeedback: vi.fn(),
  quota: vi.fn(),
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
    canAccessProduct: () => true,
    createConversation: mocks.createConversation,
    processPendingTurn: mocks.processPendingTurn,
    getChatInterpreter: mocks.getChatInterpreter,
    setResultFeedback: mocks.setResultFeedback,
    consumeChatFeedbackQuota: mocks.quota,
  };
});

import {
  startChatBootstrapAction,
  startConversationAction,
  submitResultFeedbackAction,
} from "./actions.ts";

const USER = { id: 7 };
const ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.verifySession.mockResolvedValue(USER);
  mocks.createConversation.mockResolvedValue({ status: "created", conversationId: ID });
  mocks.getChatInterpreter.mockReturnValue({ modelVersion: "m" });
  mocks.processPendingTurn.mockResolvedValue({ status: "answered" });
  mocks.setResultFeedback.mockResolvedValue("saved");
  mocks.quota.mockResolvedValue(true);
});

describe("startChatBootstrapAction", () => {
  it("sohbeti tek kez olusturur, kimligi hemen doner, ilk turu after() ile planlar", async () => {
    const result = await startChatBootstrapAction("beyaz sneaker");
    expect(result).toEqual({ status: "created", href: `/sohbet/${ID}` });
    expect(mocks.createConversation).toHaveBeenCalledTimes(1);
    expect(mocks.createConversation).toHaveBeenCalledWith(
      { db: true },
      { userId: 7, message: "beyaz sneaker" },
    );
    // Yanit donerken Gemini bekletilmez: tur yalnizca after() icinde.
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.processPendingTurn).not.toHaveBeenCalled();
  });

  it("after() isi mevcut kiralama yolunu (processPendingTurn) tam bir kez kullanir", async () => {
    await startChatBootstrapAction("merhaba");
    const task = mocks.after.mock.calls[0]?.[0] as () => Promise<void>;
    await task();
    expect(mocks.processPendingTurn).toHaveBeenCalledTimes(1);
    expect(mocks.processPendingTurn).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ userId: 7, conversationId: ID }),
    );
  });

  it("saglayici anahtari yoksa tur planlanmaz ama sohbet yine olusur (kurtarma yolu)", async () => {
    mocks.getChatInterpreter.mockImplementation(() => {
      throw new Error("missing_api_key");
    });
    expect(await startChatBootstrapAction("merhaba")).toEqual({
      status: "created",
      href: `/sohbet/${ID}`,
    });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("olusturma hatasi: error (sekme kabugu 'Tekrar dene' gosterir), tur planlanmaz", async () => {
    mocks.createConversation.mockResolvedValue({ status: "invalid_input" });
    expect(await startChatBootstrapAction("merhaba")).toEqual({ status: "error" });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("saatlik tavan, ozellik kapali ya da oturumsuz: yapay zekasiz /ara yolu, sohbet yok", async () => {
    mocks.createConversation.mockResolvedValue({ status: "rate_limited" });
    expect(await startChatBootstrapAction("masa lambası")).toEqual({
      status: "fallback",
      href: "/ara?q=masa+lambas%C4%B1",
    });
    mocks.enabled.mockReturnValue(false);
    expect((await startChatBootstrapAction("x")).status).toBe("fallback");
    mocks.enabled.mockReturnValue(true);
    mocks.verifySession.mockResolvedValue(null);
    expect((await startChatBootstrapAction("x")).status).toBe("fallback");
    expect(mocks.createConversation).toHaveBeenCalledTimes(1);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("bos ya da metin olmayan girdi: sunucuya hic gitmez", async () => {
    expect(await startChatBootstrapAction("   ")).toEqual({ status: "error" });
    expect(await startChatBootstrapAction(42)).toEqual({ status: "error" });
    expect(mocks.verifySession).not.toHaveBeenCalled();
  });
});

describe("startConversationAction (JS'siz yol)", () => {
  it("sohbeti olusturur, ilk turu after() ile planlar ve yonlendirir", async () => {
    const form = new FormData();
    form.set("q", "merhaba");
    await expect(startConversationAction(form)).rejects.toThrow(`REDIRECT:/sohbet/${ID}`);
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });
});

describe("submitResultFeedbackAction", () => {
  it("passes the session user, never a client-supplied one, with reason and comment", async () => {
    const result = await submitResultFeedbackAction(ID, 2, false, {
      reasons: ["slow"],
      comment: "yavas",
    });
    expect(result).toEqual({ status: "saved" });
    expect(mocks.quota).toHaveBeenCalledWith(7);
    expect(mocks.setResultFeedback).toHaveBeenCalledWith(
      { db: true },
      {
        userId: 7,
        conversationId: ID,
        messageSeq: 2,
        helpful: false,
        reasons: ["slow"],
        comment: "yavas",
      },
    );
  });

  it("is unavailable without a session or with the flag off, and writes nothing", async () => {
    mocks.verifySession.mockResolvedValue(null);
    expect(await submitResultFeedbackAction(ID, 2, true)).toEqual({ status: "unavailable" });
    mocks.verifySession.mockResolvedValue(USER);
    mocks.enabled.mockReturnValue(false);
    expect(await submitResultFeedbackAction(ID, 2, true)).toEqual({ status: "unavailable" });
    expect(mocks.setResultFeedback).not.toHaveBeenCalled();
  });

  it("returns rate_limited over the cap and does not write", async () => {
    mocks.quota.mockResolvedValue(false);
    expect(await submitResultFeedbackAction(ID, 2, true)).toEqual({ status: "rate_limited" });
    expect(mocks.setResultFeedback).not.toHaveBeenCalled();
  });

  it("fails closed when Redis is unavailable", async () => {
    const { RedisUnavailableError } = await import("@arilla/core");
    mocks.quota.mockRejectedValue(new RedisUnavailableError("down"));
    expect(await submitResultFeedbackAction(ID, 2, true)).toEqual({ status: "unavailable" });
    expect(mocks.setResultFeedback).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean vote before touching the limiter", async () => {
    expect(await submitResultFeedbackAction(ID, 2, "yes" as unknown as boolean)).toEqual({
      status: "invalid",
    });
    expect(mocks.quota).not.toHaveBeenCalled();
  });
});
