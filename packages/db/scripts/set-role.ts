/**
 * Yerel geliştirme veritabanında bir hesabın rolünü değiştirir
 * (docs/decisions/0039: rol arayüzden atanmaz; bu betik o SQL'in güvenli,
 * denetlenen hâlidir).
 *
 *   pnpm db:set-role -- --email kisi@ornek.com --role admin --reason "yerel test yöneticisi"
 *   pnpm db:set-role -- --public-id <uuid> --role user --reason "yetki geri alındı"
 *
 * Kurallar:
 * - YALNIZCA yerel veritabanı (`isLocal`). Uzak adres görülürse hiçbir şey
 *   yapmadan durur; üretim için docs/ops.md "Rol değiştirme".
 * - Hesap ancak tam olarak bir satır eşleşirse değişir; hesap AÇILMAZ (önce
 *   normal girişle oluşmuş olmalı).
 * - İdempotent: rol zaten istenen değerse hiçbir şey yazılmaz.
 * - Denetlenir: değişiklik ve `users.role_change` denetim satırı AYNI
 *   işlemde yazılır (`actor_role = "cli"`; `--actor-email` verilmezse aktör
 *   hedef hesabın kendisidir - ilk yönetici böyle açılır).
 * - Geri alınabilir: aynı komut `--role user` ile.
 * - Rol her istekte veritabanından okunur; açık oturumlar bir sonraki
 *   istekte yeni rolle değerlendirilir.
 *
 * Çıktıda e-posta maskelenir; parola, token ya da bağlantı adresi yazılmaz.
 */
import { parseArgs } from "node:util";
import { isLocal, ownerUrl, withClient } from "./lib.ts";

const ROLES = ["user", "creator", "moderator", "admin"] as const;
type Role = (typeof ROLES)[number];

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

function mask(email: string | null): string {
  if (!email) return "(e-posta yok)";
  const [local, domain] = email.split("@");
  return `${(local ?? "").slice(0, 2)}***@${domain ?? ""}`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

// `pnpm db:set-role -- ...` ayırıcıyı betiğe de geçirir.
const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    email: { type: "string" },
    "public-id": { type: "string" },
    role: { type: "string" },
    reason: { type: "string" },
    "actor-email": { type: "string" },
  },
});

const email = values.email?.trim().toLowerCase();
const publicId = values["public-id"]?.trim();
const reason = values.reason?.trim();
if ((email ? 1 : 0) + (publicId ? 1 : 0) !== 1) {
  fail("Tam olarak biri gerekli: --email ya da --public-id.");
}
if (!isRole(values.role)) fail(`--role şunlardan biri olmalı: ${ROLES.join(", ")}.`);
if (!reason || reason.length < 5)
  fail("--reason en az 5 karakter olmalı (denetim kaydına yazılır).");
const role: Role = values.role;

const url = ownerUrl();
if (!isLocal(url)) {
  fail("DATABASE_URL_OWNER yerel değil. Bu betik yalnızca yerel veritabanında çalışır.");
}

await withClient(url, async (client) => {
  await client.query("BEGIN");
  try {
    const target = await client.query<{ id: string; email: string | null; role: string }>(
      email
        ? "SELECT id, email, role FROM app_user WHERE lower(email) = $1 FOR UPDATE"
        : "SELECT id, email, role FROM app_user WHERE public_id::text = $1 FOR UPDATE",
      [email ?? publicId],
    );
    if (target.rows.length !== 1) {
      await client.query("ROLLBACK");
      fail(
        target.rows.length === 0
          ? "Hesap bulunamadı. Önce normal girişle (Google/Apple) bir kez giriş yap."
          : "Birden fazla hesap eşleşti; --public-id kullan.",
      );
    }
    const user = target.rows[0];
    if (user === undefined) throw new Error("unreachable");

    if (user.role === role) {
      await client.query("ROLLBACK");
      console.log(`Değişiklik yok: hesap#${user.id} ${mask(user.email)} zaten '${role}'.`);
      return;
    }

    let actorId = user.id;
    const actorEmail = values["actor-email"]?.trim().toLowerCase();
    if (actorEmail) {
      const actor = await client.query<{ id: string; role: string }>(
        "SELECT id, role FROM app_user WHERE lower(email) = $1",
        [actorEmail],
      );
      const found = actor.rows[0];
      if (actor.rows.length !== 1 || found === undefined || found.role !== "admin") {
        await client.query("ROLLBACK");
        fail("--actor-email mevcut bir yönetici hesabı olmalı.");
      }
      actorId = found.id;
    }

    await client.query("UPDATE app_user SET role = $1 WHERE id = $2", [role, user.id]);
    await client.query(
      `INSERT INTO admin_audit_event
         (actor_user_id, actor_role, action, target_type, target_id, before, after, reason)
       VALUES ($1, 'cli', 'users.role_change', 'app_user', $2, $3, $4, $5)`,
      [actorId, user.id, JSON.stringify({ role: user.role }), JSON.stringify({ role }), reason],
    );
    await client.query("COMMIT");
    console.log(
      `Rol değişti: hesap#${user.id} ${mask(user.email)} '${user.role}' → '${role}' (denetim kaydı yazıldı).`,
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
});
