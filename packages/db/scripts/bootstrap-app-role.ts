/**
 * `arilla_app` rolune LOGIN ve parola verir.
 *
 * Migration bunu yapmaz: parola depoya girmez (docs/ops.md). Parola
 * `APP_DB_PASSWORD` ortam degiskeninden okunur — yerelde `.env`, staging ve
 * production'da barindirma saglayicisinin gizli anahtar deposundan.
 *
 * Yetkiler burada DEGISTIRILMEZ; onlarin tek sahibi 0010 migration'idir.
 */
import { ownerUrl, requireEnv, withClient } from "./lib.ts";

const ROLE = "arilla_app";

await withClient(ownerUrl(), async (client) => {
  const password = requireEnv("APP_DB_PASSWORD");
  const { rowCount } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE]);
  if (rowCount === 0) {
    throw new Error(`${ROLE} rolu yok. Once pnpm db:migrate calistirin.`);
  }
  // Parola parametre olarak gecirilemez; rol adi sabit, parola quote'lanir.
  const quoted = await client.query<{ literal: string }>("SELECT quote_literal($1) AS literal", [
    password,
  ]);
  await client.query(`ALTER ROLE ${ROLE} LOGIN PASSWORD ${quoted.rows[0]?.literal}`);
  console.log(`${ROLE} rolu LOGIN yetkisi ve parola aldi.`);
});
