/**
 * Form / anket merkezi (docs/decisions/0058): gerçek oturum doğrulaması,
 * gerçek yerel Postgres ve Redis. Yalnızca `next/headers`, `next/navigation`
 * ve `next/cache` taklit edilir. Yalnızca yerel veritabanında çalışır.
 */
import { generateRawToken, hashToken } from "@arilla/core";
import { createDatabase } from "@arilla/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  token: undefined as string | undefined,
  ip: "192.0.2.10",
}));

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
class NotFoundSignal extends Error {}

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "session" && state.token ? { name, value: state.token } : undefined,
  }),
  headers: async () => new Headers({ "x-forwarded-for": state.ip }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new NotFoundSignal();
  },
  useRouter: () => ({}),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

function assertLocal(name: string): string {
  const url = process.env[name];
  if (!url) throw new Error(`${name} tanımlı değil`);
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`${name} yerel değil (${host}); bu test yalnızca yerel veritabanında çalışır.`);
  }
  return url;
}

type OwnerClient = ReturnType<typeof createDatabase>["$client"];
let ownerPool: OwnerClient | undefined;

async function owner<T>(fn: (client: OwnerClient) => Promise<T>): Promise<T> {
  ownerPool ??= createDatabase(assertLocal("DATABASE_URL_OWNER")).$client;
  return fn(ownerPool);
}

const suffix = Date.now().toString(36);
const ONBOARDING_SLUG = "seni-taniyalim";
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};

function slug(name: string): string {
  return `web-${name}-${suffix}`;
}

function definition(name: string, overrides: Record<string, unknown> = {}) {
  return {
    slug: slug(name),
    title: `Web test ${name}`,
    description: "",
    audience: "public",
    kind: "survey",
    allowSkip: true,
    allowMultipleResponses: false,
    startsAt: "",
    endsAt: "",
    questions: [
      { label: "Renk?", type: "single_choice", required: true, options: ["Kırmızı", "Mavi"] },
      { label: "Neden?", type: "long_text", required: false, options: [] },
    ],
    ...overrides,
  };
}

/** Sayfa/eylem gerçek oturumla çalışır; `outcome` yönlendirme ve 404'ü ayırt eder. */
async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "ok";
  } catch (error) {
    if (error instanceof RedirectSignal) return `redirect:${error.to}`;
    if (error instanceof NotFoundSignal) return "404";
    throw error;
  }
}

async function formFields(
  slugValue: string,
): Promise<{ id: number; fields: Array<[string, string]> }> {
  return owner(async (client) => {
    const q = await client.query(
      `SELECT q.id, q.type, q.required,
              (SELECT o.id FROM form_question_option o WHERE o.question_id = q.id ORDER BY o.sort_order LIMIT 1) AS first_option
         FROM form_question q JOIN form f ON f.id = q.form_id WHERE f.slug = $1 ORDER BY q.sort_order`,
      [slugValue],
    );
    const form = await client.query("SELECT id FROM form WHERE slug = $1", [slugValue]);
    const fields: Array<[string, string]> = [];
    for (const row of q.rows) {
      if (!row.required) continue;
      fields.push([`q_${row.id}`, row.first_option ? String(row.first_option) : "yanıt"]);
    }
    return { id: Number(form.rows[0].id), fields };
  });
}

function toFormData(fields: Array<[string, string]>): FormData {
  const data = new FormData();
  for (const [key, value] of fields) data.append(key, value);
  return data;
}

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  await owner(async (client) => {
    const people: Array<[string, string]> = [
      ["admin", "admin"],
      ["mod", "moderator"],
      ["u1", "user"],
      ["u2", "user"],
      ["u3", "user"],
    ];
    for (const [key, role] of people) {
      const res = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, $2) RETURNING id",
        [`web-forms-${key}-${suffix}@test.local`, role],
      );
      ids[key] = Number(res.rows[0].id);
      tokens[key] = generateRawToken();
      await client.query(
        "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
        [ids[key], hashToken(tokens[key] as string)],
      );
    }
  });
});

let ipCounter = 0;
beforeEach(() => {
  state.token = undefined;
  state.ip = `2001:db8::${(Date.now() % 0xffff).toString(16)}:${(++ipCounter).toString(16)}`;
});

afterAll(async () => {
  await owner(async (client) => {
    await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [
      [ids.admin, ids.mod],
    ]);
    await client.query("DELETE FROM form WHERE slug LIKE $1", [`web-%-${suffix}`]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [Object.values(ids)]);
  });
  await ownerPool?.end();
});

describe("yönetim eylemleri (forms.manage)", () => {
  it("yönetici form oluşturup yayınlar; denetime yazılır", async () => {
    const actions = await import("../yonetim/formlar/actions.ts");
    state.token = tokens.admin;
    const created = await actions.createFormAction(definition("admin"));
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) return;
    expect(await actions.setFormStatusAction(created.id, "published")).toEqual({ ok: true });
    const events = await owner(async (client) =>
      (
        await client.query(
          "SELECT action FROM admin_audit_event WHERE target_id = $1 AND target_type = 'form' ORDER BY id",
          [String(created.id)],
        )
      ).rows.map((r) => r.action),
    );
    expect(events).toEqual(["forms.create", "forms.publish"]);
  });

  it("doğrulama hatası yöneticiye Türkçe mesajla döner", async () => {
    const actions = await import("../yonetim/formlar/actions.ts");
    state.token = tokens.admin;
    const result = await actions.createFormAction(definition("bad", { slug: "Kötü Adres" }));
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.message).toMatch(/Adres/);
  });

  it("moderatör, normal kullanıcı ve anonim hiçbir eylemi yapamaz", async () => {
    const actions = await import("../yonetim/formlar/actions.ts");
    const attempts: Array<[string, string | undefined]> = [
      ["moderatör", tokens.mod],
      ["kullanıcı", tokens.u1],
      ["anonim", undefined],
    ];
    for (const [, token] of attempts) {
      state.token = token;
      const result = await outcome(() => actions.createFormAction(definition("denied")));
      expect(result).toMatch(/^(404|redirect:)/);
      expect(result).not.toBe("ok");
    }
    expect(
      await owner(async (c) =>
        Number(
          (await c.query("SELECT count(*) n FROM form WHERE slug = $1", [slug("denied")])).rows[0]
            .n,
        ),
      ),
    ).toBe(0);
  });

  it("yönetim sayfaları yetkisiz isteğe kapalıdır", async () => {
    const list = await import("../yonetim/formlar/page.tsx");
    const results = await import("../yonetim/formlar/[id]/sonuclar/page.tsx");
    for (const token of [tokens.mod, tokens.u1, undefined]) {
      state.token = token;
      expect(await outcome(() => list.default({ searchParams: Promise.resolve({}) }))).not.toBe(
        "ok",
      );
      expect(
        await outcome(() => results.default({ params: Promise.resolve({ id: "1" }) })),
      ).not.toBe("ok");
    }
    state.token = tokens.admin;
    expect(await outcome(() => list.default({ searchParams: Promise.resolve({}) }))).toBe("ok");
  });
});

describe("/anket/[slug] sayfası ve gönderim", () => {
  it("taslak 404, yayınlanınca açılır; paylaşım meta verisi yayındaki formdan gelir", async () => {
    const actions = await import("../yonetim/formlar/actions.ts");
    const page = await import("./[slug]/page.tsx");
    state.token = tokens.admin;
    const created = await actions.createFormAction(definition("page"));
    if (!created.ok) throw new Error(created.message);

    state.token = undefined;
    const props = {
      params: Promise.resolve({ slug: slug("page") }),
      searchParams: Promise.resolve({}),
    };
    expect(await outcome(() => page.default(props))).toBe("404");

    state.token = tokens.admin;
    await actions.setFormStatusAction(created.id, "published");
    state.token = undefined;
    expect(await outcome(() => page.default(props))).toBe("ok");
    const meta = await page.generateMetadata({ params: Promise.resolve({ slug: slug("page") }) });
    expect(meta.title).toBe("Web test page");
    expect(meta.robots).toMatchObject({ index: false });
    const missing = await page.generateMetadata({ params: Promise.resolve({ slug: slug("yok") }) });
    expect(missing.title).toBe("Anket");
  });

  it("girişli gönderim oturumdaki kullanıcıya bağlanır, user_id alanı reddedilir", async () => {
    const admin = await import("../yonetim/formlar/actions.ts");
    const survey = await import("./[slug]/actions.ts");
    state.token = tokens.admin;
    const created = await admin.createFormAction(definition("submit"));
    if (!created.ok) throw new Error(created.message);
    await admin.setFormStatusAction(created.id, "published");
    const { fields } = await formFields(slug("submit"));

    state.token = tokens.u1;
    const spoofed = await survey.submitSurveyAction(
      slug("submit"),
      true,
      "link",
      toFormData([...fields, ["user_id", String(ids.u2)]]),
    );
    expect(spoofed).toMatchObject({ status: "invalid", formError: "malformed" });

    const ok = await survey.submitSurveyAction(slug("submit"), true, "link", toFormData(fields));
    expect(ok).toEqual({ status: "ok" });
    const rows = await owner(
      async (c) =>
        (
          await c.query(
            "SELECT r.user_id, r.source FROM form_response r JOIN form f ON f.id = r.form_id WHERE f.slug = $1",
            [slug("submit")],
          )
        ).rows,
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].user_id)).toBe(ids.u1);
    expect(rows[0].source).toBe("link");

    // Aynı kullanıcı ikinci kez: tek yanıt.
    expect(
      await survey.submitSurveyAction(slug("submit"), true, "link", toFormData(fields)),
    ).toMatchObject({ status: "already_responded" });
  });

  it("anonim gönderim kimliksiz yazılır; sayfa girişliydi ama oturum düştüyse anonim yazılmaz", async () => {
    const admin = await import("../yonetim/formlar/actions.ts");
    const survey = await import("./[slug]/actions.ts");
    state.token = tokens.admin;
    const created = await admin.createFormAction(
      definition("anon", { allowMultipleResponses: true }),
    );
    if (!created.ok) throw new Error(created.message);
    await admin.setFormStatusAction(created.id, "published");
    const { fields } = await formFields(slug("anon"));

    state.token = undefined;
    expect(
      await survey.submitSurveyAction(slug("anon"), false, "link", toFormData(fields)),
    ).toEqual({
      status: "ok",
    });
    expect(await survey.submitSurveyAction(slug("anon"), true, "link", toFormData(fields))).toEqual(
      {
        status: "session_expired",
      },
    );
    const rows = await owner(
      async (c) =>
        (
          await c.query(
            "SELECT r.user_id FROM form_response r JOIN form f ON f.id = r.form_id WHERE f.slug = $1",
            [slug("anon")],
          )
        ).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBeNull();
  });

  it("hedef kitle: anonim ziyaretçi authenticated forma yazamaz", async () => {
    const admin = await import("../yonetim/formlar/actions.ts");
    const survey = await import("./[slug]/actions.ts");
    state.token = tokens.admin;
    const created = await admin.createFormAction(
      definition("authn", { audience: "authenticated" }),
    );
    if (!created.ok) throw new Error(created.message);
    await admin.setFormStatusAction(created.id, "published");
    const { fields } = await formFields(slug("authn"));
    state.token = undefined;
    expect(
      await survey.submitSurveyAction(slug("authn"), false, "link", toFormData(fields)),
    ).toMatchObject({
      status: "login_required",
    });
  });
});

describe("onboarding: erken erişim yönlendirmesi, geç, Hesabım", () => {
  async function joinEarlyAccess(userId: number) {
    await owner((c) =>
      c.query("INSERT INTO early_access (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]),
    );
  }

  it("ilk katılımda forma yönlendirir; 'Şimdilik geç' sonrası yönlendirmez ve kaydı bozmaz", async () => {
    const earlyAccess = await import("../erken-erisim/page.tsx");
    const survey = await import("./[slug]/actions.ts");
    await joinEarlyAccess(ids.u2 as number);
    state.token = tokens.u2;

    expect(await outcome(() => earlyAccess.default())).toBe(`redirect:/anket/${ONBOARDING_SLUG}`);

    // Anketten atlama: erken erişim sayfasına döner.
    expect(await outcome(() => survey.skipSurveyAction(ONBOARDING_SLUG, "link"))).toBe(
      "redirect:/erken-erisim",
    );
    // Tekrar otomatik yönlendirme yok; sayfa kullanıcıyı bloke etmez.
    expect(await outcome(() => earlyAccess.default())).toBe("ok");
    const rows = await owner(async (c) => ({
      early: Number(
        (await c.query("SELECT count(*) n FROM early_access WHERE user_id = $1", [ids.u2])).rows[0]
          .n,
      ),
      skip: Number(
        (await c.query("SELECT count(*) n FROM form_skip WHERE user_id = $1", [ids.u2])).rows[0].n,
      ),
      responses: Number(
        (
          await c.query(
            `SELECT count(*) n FROM form_response r JOIN form f ON f.id = r.form_id
              WHERE r.user_id = $1 AND f.slug = $2`,
            [ids.u2, ONBOARDING_SLUG],
          )
        ).rows[0].n,
      ),
    }));
    expect(rows).toEqual({ early: 1, skip: 1, responses: 0 });
  });

  it("atlanan onboarding Hesabım'da görünür, tamamlanınca kalkar ve yeniden doldurulamaz", async () => {
    const section = await import("../hesap/incomplete-forms-section.tsx");
    const survey = await import("./[slug]/actions.ts");
    const user = ids.u2 as number;
    state.token = tokens.u2;

    // Bölüm, hedef kitlesine uygun diğer yayındaki formları da listeler; onboarding bağlantısına bakılır.
    const shown = await section.IncompleteFormsSection({ userId: user });
    expect(JSON.stringify(shown)).toContain(`/anket/${ONBOARDING_SLUG}?kaynak=hesap`);

    const { fields } = await formFields(ONBOARDING_SLUG);
    const done = await survey.submitSurveyAction(
      ONBOARDING_SLUG,
      true,
      "account",
      toFormData(fields),
    );
    expect(done).toEqual({ status: "ok" });
    expect(JSON.stringify(await section.IncompleteFormsSection({ userId: user }))).not.toContain(
      ONBOARDING_SLUG,
    );
    expect(
      await survey.submitSurveyAction(ONBOARDING_SLUG, true, "account", toFormData(fields)),
    ).toMatchObject({ status: "already_responded" });
    const source = await owner(
      async (c) =>
        (
          await c.query(
            `SELECT r.source FROM form_response r JOIN form f ON f.id = r.form_id
            WHERE r.user_id = $1 AND f.slug = $2`,
            [user, ONBOARDING_SLUG],
          )
        ).rows[0].source,
    );
    expect(source).toBe("account");
  });

  it("tamamlanmış onboarding erken erişim sayfasında tekrar otomatik gösterilmez", async () => {
    const earlyAccess = await import("../erken-erisim/page.tsx");
    const user = ids.u3 as number;
    await joinEarlyAccess(user);
    state.token = tokens.u3;
    expect(await outcome(() => earlyAccess.default())).toBe(`redirect:/anket/${ONBOARDING_SLUG}`);
    const survey = await import("./[slug]/actions.ts");
    const { fields } = await formFields(ONBOARDING_SLUG);
    expect(
      await survey.submitSurveyAction(ONBOARDING_SLUG, true, "onboarding", toFormData(fields)),
    ).toEqual({
      status: "ok",
    });
    expect(await outcome(() => earlyAccess.default())).toBe("ok");
  });

  it("onboarding'i yanıtlamamış, üye olmayan kullanıcı Hesabım'da görmez", async () => {
    const section = await import("../hesap/incomplete-forms-section.tsx");
    expect(
      JSON.stringify(await section.IncompleteFormsSection({ userId: ids.u1 as number })),
    ).not.toContain(ONBOARDING_SLUG);
  });
});
