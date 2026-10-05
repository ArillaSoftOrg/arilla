/**
 * İlk giriş karşılaması yönlendirmesi (karar 0059), gerçek yerel Postgres:
 * - yeni hesap: `/hos-geldin?next=<hedef>`; hedef güvenli `next`'ten gelir.
 * - karşılama tamamlandıktan sonra aynı hesap her girişte doğrudan hedefe gider.
 * - personel (yönetici) karşılamayı görmez.
 * - `/hos-geldin` tamamlanmış hesabı hedefe atar; tamamlanmamışı gösterir.
 * - action: `newsletter` yalnızca açıkça `true` ise yazılır; Atla/devam `false`.
 * Yalnızca yerel veritabanında çalışır.
 */
import { completeOnboarding, generateRawToken, getConsents, hashToken } from "@arilla/core";
import { createDatabase, getDatabase } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ token: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "session" && state.token ? { name, value: state.token } : undefined,
    delete: () => {},
  }),
  headers: async () => new Headers(),
}));

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to;
    throw error;
  }
  return "(redirect yok)";
}

const suffix = Date.now();
const ownerUrl = process.env.DATABASE_URL_OWNER ?? "";

describe("karşılama yönlendirmesi ve action - entegrasyon", () => {
  const owner = createDatabase(ownerUrl).$client;
  const ids: number[] = [];

  async function userWithSession(label: string, role = "user", onboarded = false): Promise<number> {
    const row = await owner.query(
      "INSERT INTO app_user (email, role, onboarded_at) VALUES ($1, $2, $3) RETURNING id",
      [`onbr-${label}-${suffix}@test.local`, role, onboarded ? new Date() : null],
    );
    const id = Number(row.rows[0].id);
    ids.push(id);
    const raw = generateRawToken();
    await owner.query(
      "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')",
      [id, hashToken(raw)],
    );
    state.token = raw;
    return id;
  }

  beforeAll(async () => {
    if (!/localhost|127\.0\.0\.1/.test(ownerUrl)) {
      throw new Error("Bu test yalnızca yerel veritabanında çalışır.");
    }
  });

  afterAll(async () => {
    await owner.query("DELETE FROM user_consent WHERE user_id = ANY($1)", [ids]);
    await owner.query("DELETE FROM session WHERE user_id = ANY($1)", [ids]);
    await owner.query("DELETE FROM app_user WHERE id = ANY($1)", [ids]);
    await owner.end();
  });

  it("yeni hesap karşılamaya, tamamlanınca doğrudan hedefe gider; personel görmez", async () => {
    const { postSignInDestination } = await import("./giris/post-sign-in.ts");
    const id = await userWithSession("flow");
    const user = { id, role: "user" as const };
    expect(await postSignInDestination(user, "/alarmlar")).toBe("/hos-geldin?next=%2Ferken-erisim");
    await completeOnboarding(getDatabase(), { userId: id, newsletter: false, ip: null });
    expect(await postSignInDestination(user, "/alarmlar")).toBe("/erken-erisim");

    const adminId = await userWithSession("admin", "admin");
    expect(await postSignInDestination({ id: adminId, role: "admin" }, "/yonetim")).toBe(
      "/yonetim",
    );
  });

  it("/hos-geldin: tamamlanmamış gösterir, tamamlanmış hedefe atar, dış next süzülür", async () => {
    const { default: Page } = await import("./hos-geldin/page.tsx");
    await userWithSession("page");
    const shown = await Page({ searchParams: Promise.resolve({ next: "/alarmlar" }) });
    expect(shown).toBeTruthy();

    await userWithSession("page-done", "user", true);
    expect(
      await redirectOf(() => Page({ searchParams: Promise.resolve({ next: "/alarmlar" }) })),
    ).toBe("/alarmlar");
    expect(
      await redirectOf(() =>
        Page({ searchParams: Promise.resolve({ next: "https://evil.example/" }) }),
      ),
    ).toBe("/");
  });

  it("action: açıkça açılırsa true; Atla/devam false; tekrar çağrı kararı ezmez", async () => {
    const { completeOnboardingAction } = await import("./hos-geldin/actions.ts");
    const optIn = await userWithSession("optin");
    expect(await redirectOf(() => completeOnboardingAction({ newsletter: true, next: "/x" }))).toBe(
      "/x",
    );
    expect((await getConsents(getDatabase(), optIn)).marketing_email).toBe(true);

    const skipped = await userWithSession("skip");
    await redirectOf(() => completeOnboardingAction({ newsletter: false, next: "/" }));
    expect((await getConsents(getDatabase(), skipped)).marketing_email).toBe(false);
    // Karşılama kapalıyken yeniden gönderim true yazamaz.
    await redirectOf(() => completeOnboardingAction({ newsletter: true, next: "/" }));
    expect((await getConsents(getDatabase(), skipped)).marketing_email).toBe(false);

    // Boolean olmayan değer true sayılmaz.
    const odd = await userWithSession("odd");
    await redirectOf(() =>
      completeOnboardingAction({ newsletter: "true" as unknown as boolean, next: "/" }),
    );
    expect((await getConsents(getDatabase(), odd)).marketing_email).toBe(false);
  });
});
