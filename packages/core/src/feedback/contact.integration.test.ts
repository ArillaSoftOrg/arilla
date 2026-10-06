/**
 * Iletisim formu ve yonetim gelen kutusu - gercek Postgres ve gercek Redis
 * (yerel). 0047 kisitlari, hesap baglantisi, KVKK (silme + veri indirme) ve
 * gelen kutusu yetki/denetim davranisi. Anahtarlar ve satirlar test sonunda
 * silinir.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportUserData } from "../account/export-user-data.ts";
import { AdminForbiddenError } from "../admin/capabilities.ts";
import { listInboxMessages } from "../admin/messages.ts";
import { getRedis } from "../redis/client.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { submitContact } from "./contact.ts";
import { feedbackRateLimitKey } from "./rate-limit.ts";

const suffix = Date.now();
const USER_EMAIL = `contact-user-${suffix}@example.test`;
const ADMIN_EMAIL = `contact-admin-${suffix}@example.test`;
const SUBJECT_PREFIX = `ct-it-${suffix}`;
const ANON_IP = `198.51.100.${(suffix + 7) % 250}`;

let userId = 0;
let adminId = 0;

function fields(subject: string, extra: Partial<Record<string, string>> = {}): [string, unknown][] {
  return Object.entries({
    name: "Deniz Kaya",
    email: "Deniz@Example.test",
    category: "general",
    subject: `${SUBJECT_PREFIX} ${subject}`,
    message: "Görselle arama hangi fotoğraf türlerini destekliyor?",
    ...extra,
  });
}

async function rowBySubject(subject: string) {
  return withOwnerClient(async (client) => {
    const res = await client.query(
      `SELECT kind, user_id, name, email, category, title, priority, status, source
         FROM feedback WHERE title = $1`,
      [`${SUBJECT_PREFIX} ${subject}`],
    );
    return res.rows;
  });
}

beforeAll(async () => {
  await withOwnerClient(async (client) => {
    const res = await client.query(
      "INSERT INTO app_user (email, role) VALUES ($1, 'user'), ($2, 'admin') RETURNING id, email",
      [USER_EMAIL, ADMIN_EMAIL],
    );
    for (const row of res.rows) {
      if (row.email === USER_EMAIL) userId = Number(row.id);
      else adminId = Number(row.id);
    }
  });
});

afterAll(async () => {
  await withOwnerClient(async (client) => {
    await client.query("DELETE FROM feedback WHERE title LIKE $1", [`${SUBJECT_PREFIX}%`]);
    await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = $1", [adminId]);
    await client.query("DELETE FROM app_user WHERE email = ANY($1)", [[USER_EMAIL, ADMIN_EMAIL]]);
  });
  await getRedis().del(
    feedbackRateLimitKey({ userId, ip: null }),
    feedbackRateLimitKey({ userId: null, ip: ANON_IP }),
  );
  getRedis().disconnect();
});

describe("submitContact() - Postgres + Redis", () => {
  it("anonim: kind=contact, ad ve e-posta kayitli, source=public", async () => {
    expect(
      await submitContact(getTestDb(), { fields: fields("anonim"), userId: null, ip: ANON_IP }),
    ).toEqual({ status: "ok" });
    expect(await rowBySubject("anonim")).toEqual([
      {
        kind: "contact",
        user_id: null,
        name: "Deniz Kaya",
        email: "deniz@example.test",
        category: "general",
        title: `${SUBJECT_PREFIX} anonim`,
        priority: null,
        status: "new",
        source: "public",
      },
    ]);
  });

  it("girisli: hesaba baglanir; veri indirmede yer alir; hesap silinince silinir", async () => {
    expect(
      await submitContact(getTestDb(), {
        fields: fields("girisli", { category: "privacy", email: "yanit@example.test" }),
        userId,
        ip: null,
      }),
    ).toEqual({ status: "ok" });
    const [row] = await rowBySubject("girisli");
    expect(row).toMatchObject({
      kind: "contact",
      user_id: String(userId),
      email: "yanit@example.test",
      source: "early_access",
    });

    const exported = await exportUserData(getTestDb(), userId);
    expect(exported.feedback).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "contact",
          name: "Deniz Kaya",
          email: "yanit@example.test",
          category: "privacy",
          title: `${SUBJECT_PREFIX} girisli`,
        }),
      ]),
    );
  });
});

describe("listInboxMessages()", () => {
  it("yalnizca yonetici; moderator ve kullanici reddedilir", async () => {
    for (const role of ["moderator", "user"] as const) {
      await expect(listInboxMessages(getTestDb(), { userId: adminId, role })).rejects.toThrow(
        AdminForbiddenError,
      );
    }
  });

  it("iletisim suzgeci; hesap public kimligi; denetime icerik yazilmaz", async () => {
    const actor = { userId: adminId, role: "admin" as const };
    const page = await listInboxMessages(getTestDb(), actor, { kind: "contact" });
    expect(page.rows.every((row) => row.kind === "contact")).toBe(true);

    const mine = page.rows.filter((row) => row.subject.startsWith(SUBJECT_PREFIX));
    expect(mine.map((row) => row.subject).sort()).toEqual(
      [`${SUBJECT_PREFIX} anonim`, `${SUBJECT_PREFIX} girisli`].sort(),
    );
    const signedIn = mine.find((row) => row.subject.endsWith("girisli"));
    expect(signedIn?.accountPublicId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mine.find((row) => row.subject.endsWith("anonim"))?.accountPublicId).toBeNull();

    const audit = await withOwnerClient(async (client) => {
      const res = await client.query(
        `SELECT action, target_type, target_id, after FROM admin_audit_event
          WHERE actor_user_id = $1 ORDER BY id DESC LIMIT 1`,
        [adminId],
      );
      return res.rows[0];
    });
    expect(audit).toMatchObject({
      action: "messages.list_view",
      target_type: "feedback",
      target_id: "-",
      after: { filters: ["kind"], results: page.rows.length },
    });
    expect(JSON.stringify(audit)).not.toMatch(/Deniz|example\.test|Görselle/);
  });

  it("hesap silinince iletisim mesaji da silinir (CASCADE)", async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM app_user WHERE id = $1", [userId]);
    });
    expect(await rowBySubject("girisli")).toEqual([]);
  });
});
