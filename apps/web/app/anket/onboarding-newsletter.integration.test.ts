/**
 * Onboarding anketinin son adımı: haftalık özet (karar 0060), gerçek yerel
 * Postgres. Bülten varsayılan KAPALI; yalnızca açıkça açılırsa `true`. Atla
 * ve dokunulmamış devam `false`. İlk karar değişmez. Yalnızca onboarding
 * formu bülten rızası yazar. Yalnızca yerel veritabanında çalışır.
 */
import { generateRawToken, getConsents, hashToken } from "@arilla/core";
import { createDatabase, getDatabase } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ token: undefined as string | undefined }));

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "session" && state.token ? { name, value: state.token } : undefined,
  }),
  headers: async () => new Headers({ "x-forwarded-for": "192.0.2.77" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error("404");
  },
  useRouter: () => ({}),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const suffix = Date.now().toString(36);
const owner = createDatabase(process.env.DATABASE_URL_OWNER ?? "").$client;
const ids: Record<string, number> = {};
const tokens: Record<string, string> = {};
const formIds: number[] = [];
const requiredFields: Record<"onboarding" | "survey", Array<[string, string]>> = {
  onboarding: [],
  survey: [],
};
const slugs: { onboarding: string; survey: string } = {
  onboarding: `ob-${suffix}`,
  survey: `sv-${suffix}`,
};

async function makeUser(key: string, role = "user", onboarded = false): Promise<void> {
  const res = await owner.query(
    "INSERT INTO app_user (email, role, onboarded_at) VALUES ($1, $2, $3) RETURNING id",
    [`ob-news-${key}-${suffix}@test.local`, role, onboarded ? new Date() : null],
  );
  ids[key] = Number(res.rows[0].id);
  // Tohum onboarding formu hedef kitlesi: erken erişim listesi.
  await owner.query("INSERT INTO early_access (user_id) VALUES ($1)", [ids[key]]);
  tokens[key] = generateRawToken();
  await owner.query(
    "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [ids[key], hashToken(tokens[key] as string)],
  );
}

async function makeForm(kind: "onboarding" | "survey", slug: string): Promise<void> {
  if (kind === "onboarding") {
    // Yayında tek onboarding formu olabilir (0058): varsa (migration tohumu) onu kullan.
    const existing = await owner.query(
      "SELECT id, slug FROM form WHERE kind = 'onboarding' AND status = 'published' LIMIT 1",
    );
    if (existing.rows[0]) {
      slugs.onboarding = existing.rows[0].slug as string;
      const q = await owner.query(
        "SELECT id, type, required FROM form_question WHERE form_id = $1 ORDER BY sort_order",
        [existing.rows[0].id],
      );
      requiredFields.onboarding = await answersFor(q.rows);
      return;
    }
  }
  const f = await owner.query(
    `INSERT INTO form (slug, title, status, audience, kind, allow_skip, allow_multiple_responses, published_at)
     VALUES ($1, $2, 'published', 'authenticated', $3, true, $4, now()) RETURNING id`,
    [slug, `Test ${kind}`, kind, kind === "survey"],
  );
  const id = Number(f.rows[0].id);
  formIds.push(id);
  const q = await owner.query(
    `INSERT INTO form_question (form_id, label, type, required, sort_order)
     VALUES ($1, 'Adin?', 'short_text', true, 0) RETURNING id, type, required`,
    [id],
  );
  requiredFields[kind] = await answersFor(q.rows);
}

async function answersFor(
  rows: Array<{ id: string | number; type: string; required: boolean }>,
): Promise<Array<[string, string]>> {
  const fields: Array<[string, string]> = [];
  for (const row of rows) {
    if (!row.required) continue;
    if (row.type === "single_choice" || row.type === "multiple_choice") {
      const o = await owner.query(
        "SELECT id FROM form_question_option WHERE question_id = $1 ORDER BY sort_order LIMIT 1",
        [row.id],
      );
      fields.push([`q_${row.id}`, String(o.rows[0].id)]);
    } else {
      fields.push([`q_${row.id}`, "Ayse"]);
    }
  }
  return fields;
}

function data(kind: "onboarding" | "survey", extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  for (const [k, v] of requiredFields[kind]) fd.append(k, v);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
}

async function marketing(key: string): Promise<boolean> {
  return (await getConsents(getDatabase(), ids[key] as number)).marketing_email;
}

async function onboardedAt(key: string): Promise<Date | null> {
  const r = await owner.query("SELECT onboarded_at FROM app_user WHERE id = $1", [ids[key]]);
  return r.rows[0].onboarded_at;
}

beforeAll(async () => {
  for (const key of ["optin", "untouched", "skip", "survey", "nostep", "fresh", "done", "admin"]) {
    await makeUser(key, key === "admin" ? "admin" : "user", key === "done");
  }
  await makeForm("onboarding", slugs.onboarding);
  await makeForm("survey", slugs.survey);
});

afterAll(async () => {
  const users = Object.values(ids);
  await owner.query("DELETE FROM form WHERE id = ANY($1)", [formIds]);
  await owner.query("DELETE FROM user_consent WHERE user_id = ANY($1)", [users]);
  await owner.query("DELETE FROM session WHERE user_id = ANY($1)", [users]);
  await owner.query("DELETE FROM app_user WHERE id = ANY($1)", [users]);
  await owner.end();
});

describe("onboarding son adım: haftalık özet", () => {
  it("açıkça açılırsa true yazılır ve ilk karar işaretlenir", async () => {
    state.token = tokens.optin;
    const { submitSurveyAction } = await import("./[slug]/actions.ts");
    const result = await submitSurveyAction(
      slugs.onboarding,
      true,
      "link",
      data("onboarding", { newsletter_step: "1", newsletter_optin: "1" }),
    );
    expect(result.status).toBe("ok");
    expect(await marketing("optin")).toBe(true);
    expect(await onboardedAt("optin")).not.toBeNull();
  });

  it("dokunulmadan devam false yazar", async () => {
    state.token = tokens.untouched;
    const { submitSurveyAction } = await import("./[slug]/actions.ts");
    const result = await submitSurveyAction(
      slugs.onboarding,
      true,
      "link",
      data("onboarding", { newsletter_step: "1" }),
    );
    expect(result.status).toBe("ok");
    expect(await marketing("untouched")).toBe(false);
    expect(await onboardedAt("untouched")).not.toBeNull();
  });

  it("Şimdilik geç false yazar; sonradan gelen açık karar ilkini ezmez", async () => {
    state.token = tokens.skip;
    const { skipSurveyAction, submitSurveyAction } = await import("./[slug]/actions.ts");
    await expect(skipSurveyAction(slugs.onboarding, "link")).rejects.toBeInstanceOf(RedirectSignal);
    expect(await marketing("skip")).toBe(false);
    expect(await onboardedAt("skip")).not.toBeNull();
    // Hesabım'dan sonra doldurma: bülten alanları olsa bile ilk karar sabit.
    await submitSurveyAction(
      slugs.onboarding,
      true,
      "account",
      data("onboarding", { newsletter_step: "1", newsletter_optin: "1" }),
    );
    expect(await marketing("skip")).toBe(false);
  });

  it("adım işareti yoksa bülten kararı yazılmaz", async () => {
    state.token = tokens.nostep;
    const { submitSurveyAction } = await import("./[slug]/actions.ts");
    await submitSurveyAction(slugs.onboarding, true, "link", data("onboarding"));
    expect(await marketing("nostep")).toBe(false);
    expect(await onboardedAt("nostep")).toBeNull();
  });

  it("onboarding olmayan form bülten rızası yazamaz ve bülten alanları formu bozmaz", async () => {
    state.token = tokens.survey;
    const { submitSurveyAction } = await import("./[slug]/actions.ts");
    const result = await submitSurveyAction(
      slugs.survey,
      true,
      "link",
      data("survey", { newsletter_step: "1", newsletter_optin: "1" }),
    );
    expect(result.status).toBe("ok");
    expect(await marketing("survey")).toBe(false);
    expect(await onboardedAt("survey")).toBeNull();
  });

  it("sayfa: karar yoksa bülten adımı verilir; kararı olan (backfill) hesaba verilmez", async () => {
    const { default: Page } = await import("./[slug]/page.tsx");
    const render = async (key: string) => {
      state.token = tokens[key];
      const tree = await Page({
        params: Promise.resolve({ slug: slugs.onboarding }),
        searchParams: Promise.resolve({}),
      });
      return JSON.stringify(tree);
    };
    expect(await render("fresh")).toContain('"newsletter":{"email":');
    expect(await render("done")).toContain('"newsletter":null');
  });
});
