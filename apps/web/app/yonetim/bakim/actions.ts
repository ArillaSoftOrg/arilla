"use server";

import type { SystemStatus } from "@arilla/core/maintenance";
import { updateMaintenance } from "@arilla/core/maintenance-service";
import { requireFreshCapability } from "../../lib/dal.ts";

export async function saveMaintenance(
  input: unknown,
): Promise<
  { ok: true; status: SystemStatus } | { ok: false; message: string; reauthHref?: string }
> {
  const { actor, fresh, reauthHref } = await requireFreshCapability("maintenance.manage");
  if (!fresh) return { ok: false, message: "Bu işlem için yeniden giriş yap.", reauthHref };
  try {
    return { ok: true, status: await updateMaintenance(actor, input) };
  } catch (error) {
    // Never serialize upstream errors, which may contain infrastructure details.
    const message =
      error instanceof Error &&
      /^(Geçersiz|Bakım|Etkilenen|5–500|Durum başka|Değişiklik doğrulanamadı)/.test(error.message)
        ? error.message
        : "Bakım servisine ulaşılamıyor. Güncel durumu kontrol edip tekrar dene.";
    return { ok: false, message };
  }
}
