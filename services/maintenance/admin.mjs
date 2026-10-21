/** Emergency operator access when the application/admin DB is unavailable. */
import { readFile } from "node:fs/promises";
import { parseStatus } from "../../packages/core/src/maintenance/policy.ts";
import { maintenanceOrigin } from "../../packages/core/src/maintenance/service.ts";

try {
  const origin = maintenanceOrigin();
  const token = process.env.MAINTENANCE_ADMIN_TOKEN;
  if (!origin || !token || token.length < 32)
    throw Error("MAINTENANCE_SERVICE_URL ve MAINTENANCE_ADMIN_TOKEN gerekli.");
  const [command, file] = process.argv.slice(2);
  if (command !== "status" && command !== "set")
    throw Error("Kullanım: node admin.mjs status | set <degisiklik.json>");
  let input;
  if (command === "set") {
    if (!file) throw Error("Değişiklik JSON dosyası gerekli.");
    input = JSON.parse(await readFile(file, "utf8"));
    input.status = parseStatus(input.status);
    if (
      !Number.isSafeInteger(input.actorId) ||
      input.actorId < 1 ||
      typeof input.reason !== "string" ||
      input.reason.trim().length < 5
    ) {
      throw Error("Gerçek yönetici kimliği (actorId) ve işlem gerekçesi (reason) gerekli.");
    }
  }
  const response = await fetch(`${origin}/admin/status`, {
    method: command === "status" ? "GET" : "PUT",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  if (response.status === 409)
    throw Error("Sürüm değişti. Güncel durumu oku ve dosyadaki version değerini güncelle.");
  if (!response.ok)
    throw Error(`İşlem doğrulanamadı (HTTP ${response.status}). Güncel durumu kontrol et.`);
  console.log(JSON.stringify(await response.json(), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "İşlem tamamlanamadı.");
  process.exitCode = 1;
}
