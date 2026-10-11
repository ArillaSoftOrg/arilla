import { chatLinkFailureCopy } from "@arilla/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifySession: vi.fn(),
  loadConversation: vi.fn(),
  getChatLinkView: vi.fn(),
  linkEnabled: vi.fn(() => true),
}));

vi.mock("../lib/dal.ts", () => ({ verifySession: mocks.verifySession }));
vi.mock("@arilla/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@arilla/db")>()),
  getDatabase: () => ({ db: true }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@arilla/core", async () => {
  const actual = await vi.importActual<typeof import("@arilla/core")>("@arilla/core");
  return {
    ...actual,
    isChatDiscoveryEnabled: () => true,
    isChatLinkEnabled: mocks.linkEnabled,
    canAccessProduct: () => true,
    loadConversation: mocks.loadConversation,
    getChatLinkView: mocks.getChatLinkView,
  };
});

import { pollChatLinkAction } from "./actions.ts";
import { CHAT_LINK_COPY, unappliedPreferenceLabel } from "./chat-copy.ts";
import {
  droppedNote,
  formatSourcePrice,
  hasLinkResults,
  linkScreenFor,
  unappliedNote,
} from "./chat-link-model.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const LINK = {
  version: 1,
  requestId: "22222222-2222-4222-8222-222222222222",
  normalizedUrl: "https://example.com/p",
  remainderText: "",
  preferences: {},
  extraLinks: 0,
  errorCode: null,
  note: null,
};

function allCopy(): string[] {
  return [
    ...(Object.values(CHAT_LINK_COPY).filter((v) => typeof v === "string") as string[]),
    ...Object.values(CHAT_LINK_COPY.sameEvidence),
    ...Object.values(CHAT_LINK_COPY.preferenceKeys),
    CHAT_LINK_COPY.droppedByPreferences(12),
    unappliedNote({ unapplied: ["price", "color"] }) ?? "",
    ...["stale", "empty", "no_product", "unknown_code"].flatMap((code) => {
      const c = chatLinkFailureCopy(code, { imageEnabled: true });
      return [c.title, c.description];
    }),
  ];
}

describe("chat link copy (CLAUDE.md dil kuralları)", () => {
  it("has no forbidden words and no ALL CAPS", () => {
    for (const text of allCopy()) {
      expect(text).not.toMatch(/satın al|dupe|ucuz/i);
      expect(text).not.toMatch(/\p{Lu}{3,}/u);
    }
  });
});

describe("link view mapping", () => {
  it("maps core states to screens", () => {
    expect(linkScreenFor({ state: "pending" })).toEqual({ kind: "pending" });
    expect(linkScreenFor({ state: "stale" })).toEqual({ kind: "failure", code: "stale" });
    expect(linkScreenFor({ state: "failed", errorCode: "no_product" })).toEqual({
      kind: "failure",
      code: "no_product",
    });
    const resolved = {
      state: "resolved",
      textOnly: true,
      linkState: {},
    } as unknown as Parameters<typeof linkScreenFor>[0];
    expect(linkScreenFor(resolved)).toEqual({ kind: "resolved", textOnly: true });
  });

  it("detects empty results", () => {
    expect(hasLinkResults({ same: [], similar: [] })).toBe(false);
    expect(hasLinkResults({ same: [], similar: [{} as never] })).toBe(true);
  });
});

describe("source price", () => {
  it("shows price only with structured price and currency", () => {
    expect(formatSourcePrice({ price: null, currency: "TRY" })).toBeNull();
    expect(formatSourcePrice({ price: 129900, currency: null })).toBeNull();
    expect(formatSourcePrice({ price: 129900, currency: "TRY" })).toContain("1.299");
    expect(formatSourcePrice({ price: 5050, currency: "USD" })).toBe("50,50 USD");
  });
});

describe("preference transparency notes", () => {
  it("explains unapplied preferences and dropped candidates", () => {
    expect(unappliedNote({ unapplied: [] })).toBeNull();
    expect(unappliedNote({ unapplied: ["color"] })).toContain("renk");
    expect(unappliedNote({ unapplied: ["price", "style"] })).toContain("fiyat aralığı, stil");
    expect(unappliedPreferenceLabel("nope")).toBeNull();
    expect(droppedNote({ droppedByPreferences: 0 })).toBeNull();
    expect(droppedNote({ droppedByPreferences: 3 })).toContain("3");
  });
});

describe("pollChatLinkAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.linkEnabled.mockReturnValue(true);
    mocks.verifySession.mockResolvedValue({ id: 7 });
    mocks.loadConversation.mockResolvedValue({
      messages: [{ seq: 4, kind: "notice", link: LINK }],
    });
    mocks.getChatLinkView.mockResolvedValue({ state: "pending" });
  });

  it("is unavailable when the flag is off, without touching the database", async () => {
    mocks.linkEnabled.mockReturnValue(false);
    expect(await pollChatLinkAction(ID, 4)).toEqual({ state: "unavailable" });
    expect(mocks.loadConversation).not.toHaveBeenCalled();
  });

  it("is unavailable without a session or for bad input", async () => {
    mocks.verifySession.mockResolvedValue(null);
    expect(await pollChatLinkAction(ID, 4)).toEqual({ state: "unavailable" });
    mocks.verifySession.mockResolvedValue({ id: 7 });
    expect(await pollChatLinkAction("nope", 4)).toEqual({ state: "unavailable" });
    expect(await pollChatLinkAction(ID, 1.5)).toEqual({ state: "unavailable" });
  });

  it("reads the request id from the owner's own message, never from the client", async () => {
    mocks.loadConversation.mockResolvedValue({ messages: [{ seq: 4, kind: "search" }] });
    expect(await pollChatLinkAction(ID, 4)).toEqual({ state: "unavailable" });
    expect(mocks.loadConversation).toHaveBeenCalledWith(
      { db: true },
      { userId: 7, conversationId: ID },
    );
    expect(mocks.getChatLinkView).not.toHaveBeenCalled();
  });

  it("reports pending until the core view settles", async () => {
    expect(await pollChatLinkAction(ID, 4)).toEqual({ state: "pending" });
    expect(mocks.getChatLinkView).toHaveBeenCalledWith({ db: true }, LINK);
    for (const view of [
      { state: "stale" },
      { state: "failed", errorCode: "x" },
      { state: "resolved" },
    ]) {
      mocks.getChatLinkView.mockResolvedValue(view);
      expect(await pollChatLinkAction(ID, 4)).toEqual({ state: "done" });
    }
  });
});
