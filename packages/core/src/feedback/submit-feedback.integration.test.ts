/**
 * Geri bildirim - gercek Postgres ve gercek Redis (yerel). Oran siniri
 * `redis/counter.ts` uzerinden gercek sayacla denetlenir; anahtarlar test
 * sonunda silinir.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportUserData } from "../account/export-user-data.ts";
import { getRedis } from "../redis/client.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { FEEDBACK_MAX_SUBMISSIONS, feedbackRateLimitKey } from "./rate-limit.ts";
import { submitFeedback } from "./submit-feedback.ts";

const suffix = Date.now();
const EMAIL = `feedback-user-${suffix}@example.test`;
const OTHER_EMAIL = `feedback-other-${suffix}@example.test`;
const TITLE_PREFIX = `fb-it-${suffix}`;
// Belgeleme araligindan (RFC 5737), her kosuda farkli: onceki kosunun sayaci etkilemez.
const ANON_IP = `198.51.100.${suffix % 250}`;
const LIMIT_IP = `203.0.113.${suffix % 250}`;

let userId = 0;
let otherUserId = 0;

function fields(title: string, extra: [string, string][] = []): [string, unknown][] {
  return [
    ["category", "feature_request"],
    ["title", `${TITLE_PREFIX} ${title}`],
    ["message", "Kaydettiğim ürünler için fiyat düşünce bildirim almak istiyorum."],
    ["priority", "medium"],
    ...extra,
  ];
}

async function rowsWithTitle(title: string) {
  return withOwnerClient(async (client) => {
    const res = await client.query(
      "SELECT user_id, email, category, priority, status, source FROM feedback WHERE title = $1",
      [`${TITLE_PREFIX} ${title}`],
    );
    return res.rows;
  });
}

beforeAll(async () => {
  await withOwnerClient(async (client) => {
    const res = await client.query(
      "INSERT INTO app_user (email) VALUES ($1), ($2) RETURNING id, email",
      [EMAIL, OTHER_EMAIL],
    );
    for (const row of res.rows) {
      if (row.email === EMAIL) userId = Number(row.id);
      else otherUserId = Number(row.id);
    }
  });
});

afterAll(async () => {
  await withOwnerClient(async (client) => {
    await client.query("DELETE FROM feedback WHERE title LIKE $1", [`${TITLE_PREFIX}%`]);
    await client.query("DELETE FROM app_user WHERE email = ANY($1)", [[EMAIL, OTHER_EMAIL]]);
  });
  await getRedis().del(
    feedbackRateLimitKey({ userId, ip: null }),
    feedbackRateLimitKey({ userId: null, ip: ANON_IP }),
    feedbackRateLimitKey({ userId: null, ip: LIMIT_IP }),
  );
  getRedis().disconnect();
});

describe("submitFeedback() - Postgres + Redis", () => {
  it("anonim gonderim: user_id NULL, source public, status new", async () => {
    const result = await submitFeedback(getTestDb(), {
      fields: fields("anonim", [["email", "Ziyaretci@Example.test"]]),
      user: null,
      ip: ANON_IP,
    });
    expect(result).toEqual({ status: "ok" });
    expect(await rowsWithTitle("anonim")).toEqual([
      {
        user_id: null,
        email: "ziyaretci@example.test",
        category: "feature_request",
        priority: "medium",
        status: "new",
        source: "public",
      },
    ]);
  });

  it("girisli gonderim oturumdaki kullaniciya baglanir, formdaki e-posta yok sayilir", async () => {
    const result = await submitFeedback(getTestDb(), {
      fields: fields("girisli", [["email", OTHER_EMAIL]]),
      user: { id: userId, email: EMAIL },
      ip: ANON_IP,
    });
    expect(result).toEqual({ status: "ok" });
    const rows = await rowsWithTitle("girisli");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].user_id)).toBe(userId);
    expect(Number(rows[0].user_id)).not.toBe(otherUserId);
    expect(rows[0]).toMatchObject({ email: EMAIL, source: "early_access" });

    // KVKK "görüntüleme": hesabın veri indirme çıktısında yer alır.
    const exported = await exportUserData(getTestDb(), userId);
    expect(exported.feedback.map((f) => f.title)).toEqual([`${TITLE_PREFIX} girisli`]);
  });

  it("istemcinin user_id alani reddedilir, satir yazilmaz", async () => {
    const result = await submitFeedback(getTestDb(), {
      fields: fields("sahte-kimlik", [["user_id", String(otherUserId)]]),
      user: null,
      ip: ANON_IP,
    });
    expect(result).toMatchObject({ status: "invalid", formError: "malformed" });
    expect(await rowsWithTitle("sahte-kimlik")).toEqual([]);
  });

  it(`gercek Redis sayaciyla ${FEEDBACK_MAX_SUBMISSIONS} gonderimden sonra durur`, async () => {
    const statuses: string[] = [];
    for (let i = 0; i <= FEEDBACK_MAX_SUBMISSIONS; i++) {
      const result = await submitFeedback(getTestDb(), {
        fields: fields(`limit-${i}`),
        user: null,
        ip: LIMIT_IP,
      });
      statuses.push(result.status);
    }
    expect(statuses).toEqual([...Array(FEEDBACK_MAX_SUBMISSIONS).fill("ok"), "rate_limited"]);
    expect(await rowsWithTitle(`limit-${FEEDBACK_MAX_SUBMISSIONS}`)).toEqual([]);
  });

  it("hesap silinince kullanicinin geri bildirimi de silinir (KVKK)", async () => {
    const temp = `feedback-delete-${suffix}@example.test`;
    const tempId = await withOwnerClient(async (client) => {
      const res = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        temp,
      ]);
      return Number(res.rows[0].id);
    });
    await submitFeedback(getTestDb(), {
      fields: fields("silinecek"),
      user: { id: tempId, email: temp },
      ip: null,
    });
    expect(await rowsWithTitle("silinecek")).toHaveLength(1);
    await withOwnerClient((client) => client.query("DELETE FROM app_user WHERE id = $1", [tempId]));
    await getRedis().del(feedbackRateLimitKey({ userId: tempId, ip: null }));
    expect(await rowsWithTitle("silinecek")).toEqual([]);
  });

  it("veritabani kisitlari kaynak ile kullanicinin tutarliligini zorlar", async () => {
    await expect(
      withOwnerClient((client) =>
        client.query(
          "INSERT INTO feedback (category, title, message, source) VALUES ('bug', $1, 'mesaj metni', 'early_access')",
          [`${TITLE_PREFIX} tutarsiz`],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
