"use server";

import { type AlertKind, createAlert, InvalidAlertInputError, saveItem } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { verifySession } from "../../lib/dal.ts";

export type ProductActionStatus = "ok" | "already_exists" | "unauthenticated" | "invalid";

export async function saveItemAction(productId: number): Promise<ProductActionStatus> {
  const user = await verifySession();
  if (!user) return "unauthenticated";

  const result = await saveItem(getDatabase(), { userId: user.id, productId });
  return result.created ? "ok" : "already_exists";
}

export interface CreateAlertActionInput {
  productId: number;
  kind: AlertKind;
  targetPrice?: number | null;
  sizeNorm?: string | null;
}

/**
 * Server action gövdesi istemciden gelir ve tipte olmayan alanlar (ör.
 * `userId`) çalışma anında da gelebilir. Bu yüzden girdi yayılmaz; izin
 * verilen alanlar tek tek seçilir, `userId` yalnızca oturumdan alınır.
 */
export async function createAlertAction(
  input: CreateAlertActionInput,
): Promise<ProductActionStatus> {
  const user = await verifySession();
  if (!user) return "unauthenticated";

  try {
    const result = await createAlert(getDatabase(), {
      productId: input.productId,
      kind: input.kind,
      targetPrice: input.targetPrice,
      sizeNorm: input.sizeNorm,
      userId: user.id,
    });
    return result.created ? "ok" : "already_exists";
  } catch (error) {
    if (error instanceof InvalidAlertInputError) return "invalid";
    throw error;
  }
}
