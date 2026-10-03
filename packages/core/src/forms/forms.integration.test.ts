/**
 * Form / anket merkezi - gercek Postgres (yerel) ve gercek Redis (oran siniri
 * senaryosu). Diger senaryolar deterministik olsun diye sayaci enjekte eder.
 * Onboarding testleri migration'in ekledigi `seni-taniyalim` formunu kullanir
 * (yayinda en fazla bir onboarding formu vardir).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportUserData } from "../account/export-user-data.ts";
import { type AdminActor, AdminForbiddenError } from "../admin/capabilities.ts";
import { getRedis } from "../redis/client.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import {
  createForm,
  FormValidationError,
  getFormForEdit,
  getFormResults,
  listForms,
  setFormStatus,
  updateForm,
} from "./admin.ts";
import {
  getFormForViewer,
  getFormMeta,
  getOnboardingOffer,
  getPendingOnboarding,
  listIncompleteForms,
  skipForm,
  submitForm,
} from "./public.ts";
import { FORM_ANON_MAX, formRateLimitKey } from "./rate-limit.ts";

const suffix = Date.now().toString(36);
const db = getTestDb();
const ONBOARDING_SLUG = "seni-taniyalim";
const unlimited = async () => 1;

const userIds: Record<string, number> = {};
const createdFormIds: number[] = [];
const RATE_IP = `198.51.100.${Date.now() % 250}`;
let admin: AdminActor;
let moderator: AdminActor;
let anonRoleExists = false;

function slug(name: string): string {
  return `it-${name}-${suffix}`;
}

function definition(name: string, overrides: Record<string, unknown> = {}) {
  return {
    slug: slug(name),
    title: `Test ${name}`,
    description: "",
    audience: "public",
    kind: "survey",
    allowSkip: false,
    allowMultipleResponses: false,
    startsAt: "",
    endsAt: "",
    questions: [
      {
        label: "Renk?",
        type: "single_choice",
        required: true,
        options: ["Kırmızı", "Mavi", "Yeşil"],
      },
      { label: "Hangileri?", type: "multiple_choice", required: false, options: ["A", "B", "C"] },
      { label: "Neden?", type: "long_text", required: false, options: [] },
    ],
    ...overrides,
  };
}

async function newForm(name: string, overrides: Record<string, unknown> = {}, publish = true) {
  const { id } = await createForm(db, admin, definition(name, overrides));
  createdFormIds.push(id);
  if (publish) await setFormStatus(db, admin, id, "published");
  return id;
}

async function viewOpen(slugValue: string, user: { id: number } | null = null) {
  const view = await getFormForViewer(db, slugValue, user);
  if (view.status !== "open") throw new Error(`form acik degil: ${view.status}`);
  return view.form;
}

/** Soru etiketine gore alan adlari: q_<id>. */
function pick(form: Awaited<ReturnType<typeof viewOpen>>, label: string) {
  const question = form.questions.find((q) => q.label === label);
  if (!question) throw new Error(`soru yok: ${label}`);
  return question;
}

function color(form: Awaited<ReturnType<typeof viewOpen>>, option: string): [string, string] {
  const question = pick(form, "Renk?");
  const found = question.options.find((o) => o.label === option);
  if (!found) throw new Error("secenek yok");
  return [`q_${question.id}`, String(found.id)];
}

async function submit(
  slugValue: string,
  fields: Array<[string, unknown]>,
  user: { id: number } | null,
  extra: { ip?: string | null } = {},
) {
  return submitForm(
    db,
    { slug: slugValue, fields, user, ip: extra.ip ?? null, source: "link" },
    unlimited,
  );
}

async function count(sql: string, params: unknown[]): Promise<number> {
  return withOwnerClient(async (client) => Number((await client.query(sql, params)).rows[0].n));
}

beforeAll(async () => {
  await withOwnerClient(async (client) => {
    const res = await client.query(
      `INSERT INTO app_user (email, role) VALUES
         ($1, 'admin'), ($2, 'moderator'), ($3, 'user'), ($4, 'user'), ($5, 'user')
       RETURNING id, email`,
      [
        `forms-admin-${suffix}@example.test`,
        `forms-mod-${suffix}@example.test`,
        `forms-u1-${suffix}@example.test`,
        `forms-u2-${suffix}@example.test`,
        `forms-u3-${suffix}@example.test`,
      ],
    );
    for (const row of res.rows) {
      userIds[String(row.email).replace(`-${suffix}@example.test`, "").replace("forms-", "")] =
        Number(row.id);
    }
    anonRoleExists =
      Number(
        (await client.query("SELECT count(*) n FROM pg_roles WHERE rolname = 'anon'")).rows[0].n,
      ) > 0;
  });
  admin = { userId: userIds.admin as number, role: "admin" };
  moderator = { userId: userIds.mod as number, role: "moderator" };
});

afterAll(async () => {
  await withOwnerClient(async (client) => {
    await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [
      [userIds.admin, userIds.mod],
    ]);
    await client.query("DELETE FROM form WHERE slug LIKE $1", [`it-%-${suffix}`]);
    await client.query("DELETE FROM app_user WHERE email LIKE $1", [
      `forms-%-${suffix}@example.test`,
    ]);
  });
  await getRedis().del(formRateLimitKey({ formId: 0, userId: null, ip: RATE_IP }));
  getRedis().disconnect();
});

describe("yetki ve denetim", () => {
  it("yönetici form oluşturur; denetim kaydı soru metni ve cevap içermez", async () => {
    const id = await newForm("create", {}, false);
    const events = await withOwnerClient(
      async (client) =>
        (
          await client.query(
            "SELECT action, target_type, after FROM admin_audit_event WHERE target_id = $1 AND target_type = 'form'",
            [String(id)],
          )
        ).rows,
    );
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("forms.create");
    expect(JSON.stringify(events[0].after)).not.toMatch(/Renk|Kırmızı/);
    expect(events[0].after).toMatchObject({ questionCount: 3, status: "draft" });
  });

  it("moderatör ve normal kullanıcı hiçbir form işlemini yapamaz", async () => {
    const id = await newForm("auth", {}, false);
    for (const actor of [moderator, { userId: userIds.u1 as number, role: "user" as const }]) {
      await expect(createForm(db, actor, definition("x"))).rejects.toBeInstanceOf(
        AdminForbiddenError,
      );
      await expect(listForms(db, actor, 1)).rejects.toBeInstanceOf(AdminForbiddenError);
      await expect(getFormForEdit(db, actor, id)).rejects.toBeInstanceOf(AdminForbiddenError);
      await expect(setFormStatus(db, actor, id, "published")).rejects.toBeInstanceOf(
        AdminForbiddenError,
      );
      await expect(getFormResults(db, actor, id)).rejects.toBeInstanceOf(AdminForbiddenError);
    }
  });

  it("yayın ve kapatma denetlenir", async () => {
    const id = await newForm("audit-status", {}, false);
    await setFormStatus(db, admin, id, "published");
    await setFormStatus(db, admin, id, "closed");
    const actions = await withOwnerClient(async (client) =>
      (
        await client.query(
          "SELECT action FROM admin_audit_event WHERE target_id = $1 AND target_type = 'form' ORDER BY id",
          [String(id)],
        )
      ).rows.map((r) => r.action),
    );
    expect(actions).toEqual(["forms.create", "forms.publish", "forms.close"]);
  });
});

describe("görünürlük ve hedef kitle", () => {
  it("taslak ziyaretçiye görünmez, yayınlanınca görünür", async () => {
    const id = await newForm("visibility", {}, false);
    expect((await getFormForViewer(db, slug("visibility"), null)).status).toBe("not_found");
    expect(await getFormMeta(db, slug("visibility"))).toBeNull();
    await setFormStatus(db, admin, id, "published");
    expect((await getFormForViewer(db, slug("visibility"), null)).status).toBe("open");
    expect(await getFormMeta(db, slug("visibility"))).toMatchObject({ title: "Test visibility" });
  });

  it("kapalı, süresi dolmuş ve henüz başlamamış form için doğru durum döner", async () => {
    const id = await newForm("windows");
    const future = new Date(Date.now() + 3_600_000);
    expect((await getFormForViewer(db, slug("windows"), null, future)).status).toBe("open");
    await setFormStatus(db, admin, id, "closed");
    expect((await getFormForViewer(db, slug("windows"), null)).status).toBe("closed");
    expect((await submit(slug("windows"), [], null)).status).toBe("closed");

    await newForm("later", { startsAt: "2099-01-01T10:00" });
    expect((await getFormForViewer(db, slug("later"), null)).status).toBe("not_started");
    await newForm("ended", { endsAt: "2020-01-01T10:00", startsAt: "2019-01-01T10:00" });
    expect((await getFormForViewer(db, slug("ended"), null)).status).toBe("closed");
  });

  it("authenticated: anonim giriş ister, girişli açar", async () => {
    await newForm("authn", { audience: "authenticated" });
    expect((await getFormForViewer(db, slug("authn"), null)).status).toBe("login_required");
    expect((await getFormForViewer(db, slug("authn"), { id: userIds.u1 as number })).status).toBe(
      "open",
    );
    expect((await submit(slug("authn"), [], null)).status).toBe("login_required");
  });

  it("early_access: üye olmayan giremez, üye girer", async () => {
    await newForm("early", { audience: "early_access" });
    expect((await getFormForViewer(db, slug("early"), null)).status).toBe("login_required");
    expect((await getFormForViewer(db, slug("early"), { id: userIds.u2 as number })).status).toBe(
      "early_access_required",
    );
    await withOwnerClient((client) =>
      client.query("INSERT INTO early_access (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [
        userIds.u2,
      ]),
    );
    expect((await getFormForViewer(db, slug("early"), { id: userIds.u2 as number })).status).toBe(
      "open",
    );
  });
});

describe("gönderim doğrulaması", () => {
  it("zorunlu soru, geçersiz seçenek ve bilinmeyen alan reddedilir; satır yazılmaz", async () => {
    await newForm("validation");
    const form = await viewOpen(slug("validation"));
    const before = () =>
      count(
        "SELECT count(*) n FROM form_response r JOIN form f ON f.id = r.form_id WHERE f.slug = $1",
        [slug("validation")],
      );

    const missing = await submit(slug("validation"), [], null);
    expect(missing).toMatchObject({ status: "invalid" });
    expect(
      (missing as { fieldErrors: Record<number, string> }).fieldErrors[pick(form, "Renk?").id],
    ).toBe("required");

    const [name] = color(form, "Mavi");
    const fake = await submit(slug("validation"), [[name, "999999999"]], null);
    expect(
      (fake as { fieldErrors: Record<number, string> }).fieldErrors[pick(form, "Renk?").id],
    ).toBe("invalid");

    const userIdField = await submit(
      slug("validation"),
      [color(form, "Mavi"), ["user_id", "1"]],
      null,
    );
    expect(userIdField).toMatchObject({ status: "invalid", formError: "malformed" });

    expect(await before()).toBe(0);
  });

  it("başka formun seçeneği kabul edilmez", async () => {
    await newForm("cross-a");
    await newForm("cross-b");
    const a = await viewOpen(slug("cross-a"));
    const b = await viewOpen(slug("cross-b"));
    const [, optionOfA] = color(a, "Mavi");
    const result = await submit(slug("cross-b"), [[`q_${pick(b, "Renk?").id}`, optionOfA]], null);
    expect(result).toMatchObject({ status: "invalid" });
  });
});

describe("kimlik ve tek yanıt", () => {
  it("girişli yanıt oturumdaki kullanıcıya bağlanır; anonim yanıtın user_id'si boştur", async () => {
    await newForm("identity", { allowMultipleResponses: true });
    const form = await viewOpen(slug("identity"));
    const answers: Array<[string, unknown]> = [
      color(form, "Yeşil"),
      [`q_${pick(form, "Neden?").id}`, "Beğendim"],
    ];

    expect((await submit(slug("identity"), answers, { id: userIds.u1 as number })).status).toBe(
      "ok",
    );
    expect((await submit(slug("identity"), answers, null)).status).toBe("ok");

    const rows = await withOwnerClient(
      async (client) =>
        (
          await client.query(
            `SELECT r.user_id, r.source, count(a.id)::int answers
             FROM form_response r JOIN form f ON f.id = r.form_id
             LEFT JOIN form_answer a ON a.response_id = r.id
            WHERE f.slug = $1 GROUP BY r.id ORDER BY r.id`,
            [slug("identity")],
          )
        ).rows,
    );
    expect(rows.map((r) => (r.user_id === null ? null : Number(r.user_id)))).toEqual([
      userIds.u1,
      null,
    ]);
    expect(rows.every((r) => r.source === "link" && r.answers === 2)).toBe(true);
  });

  it("tek yanıtlı formda girişli kullanıcı ikinci kez gönderemez", async () => {
    await newForm("single");
    const form = await viewOpen(slug("single"));
    const user = { id: userIds.u1 as number };
    expect((await submit(slug("single"), [color(form, "Mavi")], user)).status).toBe("ok");
    expect((await submit(slug("single"), [color(form, "Mavi")], user)).status).toBe(
      "already_responded",
    );
    expect((await getFormForViewer(db, slug("single"), user)).status).toBe("already_responded");
    // Başka kullanıcı yanıtlayabilir.
    expect(
      (await submit(slug("single"), [color(form, "Mavi")], { id: userIds.u2 as number })).status,
    ).toBe("ok");
  });

  it("eşzamanlı çift gönderimde motor yalnızca birini yazar", async () => {
    await newForm("race");
    const form = await viewOpen(slug("race"));
    const user = { id: userIds.u3 as number };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => submit(slug("race"), [color(form, "Mavi")], user)),
    );
    expect(results.filter((r) => r.status === "ok")).toHaveLength(1);
    expect(results.filter((r) => r.status === "already_responded")).toHaveLength(4);
    expect(
      await count(
        "SELECT count(*) n FROM form_response r JOIN form f ON f.id = r.form_id WHERE f.slug = $1",
        [slug("race")],
      ),
    ).toBe(1);
  });

  it("çok yanıtlı formda tekrar gönderime izin verir", async () => {
    await newForm("multi", { allowMultipleResponses: true });
    const form = await viewOpen(slug("multi"));
    const user = { id: userIds.u1 as number };
    expect((await submit(slug("multi"), [color(form, "Mavi")], user)).status).toBe("ok");
    expect((await submit(slug("multi"), [color(form, "Mavi")], user)).status).toBe("ok");
  });
});

describe("oran sınırı (gerçek Redis)", () => {
  it("anonim gönderim sınırdan sonra durur ve satır yazılmaz", async () => {
    const id = await newForm("ratelimit", { allowMultipleResponses: true });
    const form = await viewOpen(slug("ratelimit"));
    const key = formRateLimitKey({ formId: id, userId: null, ip: RATE_IP });
    await getRedis().del(key);
    const run = () =>
      submitForm(db, {
        slug: slug("ratelimit"),
        fields: [color(form, "Mavi")],
        user: null,
        ip: RATE_IP,
        source: "link",
      });
    for (let i = 0; i < FORM_ANON_MAX; i++) expect((await run()).status).toBe("ok");
    expect((await run()).status).toBe("rate_limited");
    expect(
      await count(
        "SELECT count(*) n FROM form_response r JOIN form f ON f.id = r.form_id WHERE f.slug = $1",
        [slug("ratelimit")],
      ),
    ).toBe(FORM_ANON_MAX);
    await getRedis().del(key);
  });
});

describe("onboarding: geç, tamamla, Hesabım", () => {
  it("seed'lenen onboarding formu yayında, erken erişim hedefli ve 5 soruludur", async () => {
    const view = await getFormForViewer(db, ONBOARDING_SLUG, { id: userIds.u2 as number });
    expect(view.status).toBe("open");
    if (view.status !== "open") return;
    expect(view.form).toMatchObject({
      kind: "onboarding",
      audience: "early_access",
      allowSkip: true,
    });
    expect(view.form.questions).toHaveLength(5);
    expect(view.form.questions.filter((q) => q.required)).toHaveLength(3);
    expect(view.form.questions[0]?.options.map((o) => o.label)).toContain("Instagram");
  });

  it("atlayan kullanıcı engellenmez, erken erişim kaydı kalır, form Hesabım'da görünür", async () => {
    const user = userIds.u2 as number;
    await withOwnerClient((client) =>
      client.query("INSERT INTO early_access (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [user]),
    );
    expect(await getPendingOnboarding(db, user)).toMatchObject({ slug: ONBOARDING_SLUG });

    expect(await skipForm(db, { slug: ONBOARDING_SLUG, user: { id: user } })).toEqual({
      status: "ok",
    });
    // İdempotent.
    expect(await skipForm(db, { slug: ONBOARDING_SLUG, user: { id: user } })).toEqual({
      status: "ok",
    });

    expect(await getPendingOnboarding(db, user)).toBeNull(); // otomatik yönlendirme kalkar
    const listed = await listIncompleteForms(db, user);
    expect(listed.find((f) => f.slug === ONBOARDING_SLUG)).toMatchObject({
      skipped: true,
      kind: "onboarding",
    });
    expect(await getOnboardingOffer(db, user)).toMatchObject({
      slug: ONBOARDING_SLUG,
      skipped: true,
    });

    // Tamamlandı SAYILMAZ: yanıt yok, erken erişim kaydı duruyor.
    expect(
      await count(
        `SELECT count(*) n FROM form_response r JOIN form f ON f.id = r.form_id
          WHERE r.user_id = $1 AND f.slug = $2`,
        [user, ONBOARDING_SLUG],
      ),
    ).toBe(0);
    expect(await count("SELECT count(*) n FROM early_access WHERE user_id = $1", [user])).toBe(1);
    expect(await count("SELECT count(*) n FROM form_skip WHERE user_id = $1", [user])).toBe(1);

    // Hesabım'dan sonra doldurur.
    const form = await viewOpen(ONBOARDING_SLUG, { id: user });
    const fields: Array<[string, unknown]> = form.questions
      .filter((q) => q.required)
      .map((q) => [`q_${q.id}`, String(q.options[0]?.id)] as [string, unknown]);
    const result = await submitForm(
      db,
      { slug: ONBOARDING_SLUG, fields, user: { id: user }, ip: null, source: "account" },
      unlimited,
    );
    expect(result.status).toBe("ok");
    // Tamamlanan form artık listelenmez / otomatik gösterilmez / yeniden doldurulamaz.
    expect(
      (await listIncompleteForms(db, user)).find((f) => f.slug === ONBOARDING_SLUG),
    ).toBeUndefined();
    expect(await getPendingOnboarding(db, user)).toBeNull();
    expect(await getOnboardingOffer(db, user)).toBeNull();
    expect((await getFormForViewer(db, ONBOARDING_SLUG, { id: user })).status).toBe(
      "already_responded",
    );
  });

  it("yanıtlayan kullanıcıda onboarding hiç bekleyen olarak görünmez", async () => {
    const user = userIds.u3 as number;
    await withOwnerClient((client) =>
      client.query("INSERT INTO early_access (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [user]),
    );
    expect(await getPendingOnboarding(db, user)).toMatchObject({ slug: ONBOARDING_SLUG });
    const form = await viewOpen(ONBOARDING_SLUG, { id: user });
    const fields = form.questions
      .filter((q) => q.required)
      .map((q) => [`q_${q.id}`, String(q.options[0]?.id)] as [string, unknown]);
    expect((await submit(ONBOARDING_SLUG, fields, { id: user })).status).toBe("ok");
    expect(await getPendingOnboarding(db, user)).toBeNull();
  });

  it("onboarding atlanamaz olarak işaretlendiyse atlama reddedilir; üyelik gerekir", async () => {
    // Üye olmayan kullanıcı onboarding'i atlayamaz (hedef kitle kapısı).
    const outsider = await withOwnerClient(async (client) =>
      Number(
        (
          await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
            `forms-outsider-${suffix}@example.test`,
          ])
        ).rows[0].id,
      ),
    );
    expect(await skipForm(db, { slug: ONBOARDING_SLUG, user: { id: outsider } })).toMatchObject({
      status: "early_access_required",
    });
    expect(await skipForm(db, { slug: ONBOARDING_SLUG, user: null })).toMatchObject({
      status: "login_required",
    });
    const noSkip = await newForm("noskip", { audience: "authenticated", allowSkip: false });
    expect(noSkip).toBeGreaterThan(0);
    expect(
      await skipForm(db, { slug: slug("noskip"), user: { id: userIds.u1 as number } }),
    ).toEqual({
      status: "not_allowed",
    });
  });

  it("ikinci yayında onboarding formu yayınlanamaz", async () => {
    const id = await newForm("onb2", { kind: "onboarding", audience: "early_access" }, false);
    await expect(setFormStatus(db, admin, id, "published")).rejects.toThrow(/onboarding/i);
  });
});

describe("sonuçlar", () => {
  it("seçenek dağılımı, yüzde, metin yanıtları ve sayılar doğru", async () => {
    const id = await newForm("results", { allowMultipleResponses: true });
    const form = await viewOpen(slug("results"));
    const why = `q_${pick(form, "Neden?").id}`;
    const multi = pick(form, "Hangileri?");
    const optionIdOf = (label: string) => String(multi.options.find((o) => o.label === label)?.id);

    await submit(slug("results"), [color(form, "Kırmızı"), [why, "Çok hoş"]], {
      id: userIds.u1 as number,
    });
    await submit(
      slug("results"),
      [
        color(form, "Kırmızı"),
        [`q_${multi.id}`, optionIdOf("A")],
        [`q_${multi.id}`, optionIdOf("C")],
      ],
      null,
    );
    await submit(slug("results"), [color(form, "Mavi")], null);

    const results = await getFormResults(db, admin, id);
    expect(results).toMatchObject({
      totalResponses: 3,
      authenticatedResponses: 1,
      anonymousResponses: 2,
      skipCount: 0,
    });
    const colorResult = results?.questions.find((q) => q.label === "Renk?");
    expect(colorResult && "options" in colorResult && colorResult.options).toEqual([
      { label: "Kırmızı", count: 2, percent: 66.7 },
      { label: "Mavi", count: 1, percent: 33.3 },
      { label: "Yeşil", count: 0, percent: 0 },
    ]);
    expect(colorResult?.answered).toBe(3);
    const multiResult = results?.questions.find((q) => q.label === "Hangileri?");
    expect(
      multiResult && "options" in multiResult && multiResult.options.map((o) => o.count),
    ).toEqual([1, 0, 1]);
    expect(multiResult?.answered).toBe(1);
    const text = results?.questions.find((q) => q.label === "Neden?");
    expect(text && "answers" in text && text.answers).toHaveLength(1);
    if (text && "answers" in text) {
      expect(text.answers[0]?.text).toBe("Çok hoş");
      // E-posta değil, hesabın public kimliği.
      expect(text.answers[0]?.userRef).toMatch(/^[0-9a-f-]{36}$/);
    }
    const viewEvents = await count(
      "SELECT count(*) n FROM admin_audit_event WHERE target_id = $1 AND action = 'forms.results_view'",
      [String(id)],
    );
    expect(viewEvents).toBe(1);
  });
});

describe("düzenleme kuralları", () => {
  it("yanıt alınmış formun soruları kilitlenir; başlık değişir; eski sürüm çakışır", async () => {
    const id = await newForm("editlock", { allowMultipleResponses: true });
    const form = await viewOpen(slug("editlock"));
    await submit(slug("editlock"), [color(form, "Mavi")], null);

    const current = await getFormForEdit(db, admin, id);
    if (!current) throw new Error("form yok");
    const base = definition("editlock", { allowMultipleResponses: true });

    // Başlık değişebilir.
    const renamed = await updateForm(
      db,
      admin,
      id,
      { ...base, title: "Yeni başlık" },
      current.updatedAt.getTime(),
    );
    expect(renamed).toEqual({ status: "updated" });

    // Sorular değişemez.
    const fresh = await getFormForEdit(db, admin, id);
    await expect(
      updateForm(
        db,
        admin,
        id,
        {
          ...base,
          questions: [{ label: "Başka", type: "short_text", required: false, options: [] }],
        },
        (fresh as { updatedAt: Date }).updatedAt.getTime(),
      ),
    ).rejects.toThrow(/soruları değiştirilemez/);

    // Eski sürümle kaydetme çakışır.
    expect(
      await updateForm(db, admin, id, { ...base, title: "Eski" }, current.updatedAt.getTime()),
    ).toEqual({
      status: "conflict",
    });

    // Yayınlanmış formun adresi değişmez.
    await expect(
      updateForm(
        db,
        admin,
        id,
        { ...base, slug: slug("editlock-yeni") },
        ((await getFormForEdit(db, admin, id)) as { updatedAt: Date }).updatedAt.getTime(),
      ),
    ).rejects.toThrow(/adresi değiştirilemez/);
  });

  it("yanıtsız formun soruları değişebilir; aynı adres ikinci formda reddedilir", async () => {
    const id = await newForm("editfree", {}, false);
    const current = await getFormForEdit(db, admin, id);
    if (!current) throw new Error("form yok");
    const updated = await updateForm(
      db,
      admin,
      id,
      definition("editfree", {
        questions: [{ label: "Tek", type: "short_text", required: true, options: [] }],
      }),
      current.updatedAt.getTime(),
    );
    expect(updated).toEqual({ status: "updated" });
    expect((await getFormForEdit(db, admin, id))?.questions).toHaveLength(1);

    await expect(createForm(db, admin, definition("editfree"))).rejects.toThrow(
      /zaten kullanılıyor/,
    );
    expect(createForm(db, admin, definition("editfree"))).rejects.toBeInstanceOf(
      FormValidationError,
    );
  });

  it("soru olmayan form yayınlanamaz (doğrulama zaten en az bir soru ister)", async () => {
    await expect(createForm(db, admin, definition("noq", { questions: [] }))).rejects.toThrow(
      /soru/,
    );
  });
});

describe("KVKK ve Data API", () => {
  it("veri indirme çıktısı anket yanıtlarını içerir; hesap silinince yanıtlar silinir", async () => {
    await newForm("export", { allowMultipleResponses: true });
    const form = await viewOpen(slug("export"));
    const multi = pick(form, "Hangileri?");
    const user = await withOwnerClient(async (client) =>
      Number(
        (
          await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
            `forms-exporter-${suffix}@example.test`,
          ])
        ).rows[0].id,
      ),
    );
    await submit(
      slug("export"),
      [
        color(form, "Mavi"),
        [`q_${multi.id}`, String(multi.options[0]?.id)],
        [`q_${multi.id}`, String(multi.options[1]?.id)],
      ],
      { id: user },
    );
    const exported = await exportUserData(db, user);
    expect(exported.surveyResponses).toHaveLength(1);
    expect(exported.surveyResponses[0]).toMatchObject({ formTitle: "Test export" });
    expect(exported.surveyResponses[0]?.answers).toEqual([
      { question: "Renk?", answer: "Mavi" },
      { question: "Hangileri?", answer: "A, B" },
    ]);

    await withOwnerClient((client) => client.query("DELETE FROM app_user WHERE id = $1", [user]));
    expect(await count("SELECT count(*) n FROM form_response WHERE user_id = $1", [user])).toBe(0);
    expect(
      await count(
        `SELECT count(*) n FROM form_answer a JOIN form_response r ON r.id = a.response_id
          JOIN form f ON f.id = r.form_id WHERE f.slug = $1 AND r.user_id IS NULL AND false`,
        [slug("export")],
      ),
    ).toBe(0);
  });

  it("anon / authenticated rollerinin form tablolarında hiç yetkisi yoktur (Data API)", async () => {
    if (!anonRoleExists) return; // Roller yalnızca Supabase'de (ve taklit eden test DB'sinde) vardır.
    const grants = await withOwnerClient(async (client) =>
      Number(
        (
          await client.query(
            `SELECT count(*) n FROM information_schema.role_table_grants
              WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
                AND table_name IN ('form', 'form_question', 'form_question_option', 'form_response', 'form_answer', 'form_skip', 'feedback')`,
          )
        ).rows[0].n,
      ),
    );
    expect(grants).toBe(0);
  });
});
