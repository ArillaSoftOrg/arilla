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

export async function createAlertAction(
  input: CreateAlertActionInput,
): Promise<ProductActionStatus> {
  const user = await verifySession();
  if (!user) return "unauthenticated";

  try {
    const result = await createAlert(getDatabase(), { userId: user.id, ...input });
    return result.created ? "ok" : "already_exists";
  } catch (error) {
    if (error instanceof InvalidAlertInputError) return "invalid";
    throw error;
  }
}
