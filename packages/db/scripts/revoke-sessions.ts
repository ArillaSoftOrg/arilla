/**
 * Acil durum: bir hesabın BÜTÜN oturumlarını kapatır, istenirse rolünü
 * 'user'a düşürür (docs/decisions/0050, docs/ops.md "Acil oturum kapatma").
 * Ele geçirilmiş yönetici hesabı için: uygulama ya da yönetim paneli
 * erişilemez olsa da sahip rolüyle çalışır.
 *
 *   pnpm db:revoke-sessions -- --email kisi@ornek.com --reason "cerez sizintisi" [--demote]
 *   pnpm db:revoke-sessions -- --public-id <uuid> --reason "..." --confirm-remote
 *
 * Kurallar:
 * - Uzak (üretim) veritabanında YALNIZCA `--confirm-remote` ile çalışır.
 * - Tek işlem: oturum silme, `sessions.revoke_all` denetim satırı ve
 *   (`--demote` ise) rol düşürme birlikte yazılır ya da hiçbiri.
 * - Rol düşürmenin denetim satırını 0036 tetikleyicisi yazar.
 * - Aktör: `--actor-email` (mevcut yönetici) ya da boş (`actor_role = "cli"`).
 * - Çıktıda e-posta maskelenir; bağlantı adresi, token yazılmaz.
 */
import { parseArgs } from "node:util";
import { isLocal, ownerUrl, withClient } from "./lib.ts";

function mask(email: string | null): string {
  if (!email) return "(e-posta yok)";
  const [local, domain] = email.split("@");
  return `${(local ?? "").slice(0, 2)}***@${domain ?? ""}`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    email: { type: "string" },
    "public-id": { type: "string" },
    reason: { type: "string" },
    "actor-email": { type: "string" },
    demote: { type: "boolean", default: false },
    "confirm-remote": { type: "boolean", default: false },
  },
});

const email = values.email?.trim().toLowerCase();
const publicId = values["public-id"]?.trim().toLowerCase();
const reason = values.reason?.trim();
if ((email ? 1 : 0) + (publicId ? 1 : 0) !== 1) {
  fail("Tam olarak biri gerekli: --email ya da --public-id.");
}
if (!reason || reason.length < 5 || reason.length > 300) {
  fail("--reason 5-300 karakter olmalı (denetim kaydına yazılır).");
}

const url = ownerUrl();
if (!isLocal(url) && !values["confirm-remote"]) {
  fail("Veritabanı yerel değil. Üretimde çalıştırmak için --confirm-remote ver.");
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
        target.rows.length === 0 ? "Hesap bulunamadı." : "Birden fazla hesap; --public-id kullan.",
      );
    }
    const user = target.rows[0];
    if (user === undefined) throw new Error("unreachable");

    let actorId: string | null = null;
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

    const deleted = await client.query("DELETE FROM session WHERE user_id = $1", [user.id]);
    const count = deleted.rowCount ?? 0;
    await client.query(
      `INSERT INTO admin_audit_event
         (actor_user_id, actor_role, action, target_type, target_id, after, reason)
       VALUES ($1, 'cli', 'sessions.revoke_all', 'app_user', $2, $3, $4)`,
      [actorId, user.id, JSON.stringify({ count, scope: "emergency", outcome: "applied" }), reason],
    );

    let demoted = false;
    if (values.demote && user.role !== "user") {
      const trigger = await client.query(
        "SELECT 1 FROM pg_trigger WHERE tgname = 'app_user_role_change_audit' AND NOT tgisinternal",
      );
      if (trigger.rows.length !== 1) {
        await client.query("ROLLBACK");
        fail("Rol denetim tetikleyicisi yok (0036). Önce `pnpm db:migrate` çalıştır.");
      }
      await client.query(
        `SELECT set_config('arilla.audit_actor_user_id', $1, true),
                set_config('arilla.audit_actor_role', 'cli', true),
                set_config('arilla.audit_reason', $2, true)`,
        [actorId ?? "", reason],
      );
      await client.query("UPDATE app_user SET role = 'user' WHERE id = $1", [user.id]);
      demoted = true;
    }

    await client.query("COMMIT");
    console.log(
      `Tamam: hesap#${user.id} ${mask(user.email)} — ${count} oturum kapatıldı` +
        (demoted ? `, rol '${user.role}' → 'user'` : "") +
        " (denetim kaydı yazıldı).",
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
});
