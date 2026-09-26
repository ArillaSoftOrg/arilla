"use server";

import { approveMatch, isReviewReason, rejectMatch } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { requireCapability } from "../../lib/dal.ts";

export interface ReviewActionResult {
  found: boolean;
  /** Teklif bu arada başka bir ürüne bağlanmış; hiçbir şey değişmedi. */
  conflict?: boolean;
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Yetki her çağrıda sunucuda denetlenir; core aynı yeteneği ikinci kez ister. */
export async function approveMatchAction(matchCandidateId: number): Promise<ReviewActionResult> {
  const { actor } = await requireCapability("matching.review");
  if (!isId(matchCandidateId)) return { found: false };
  return approveMatch(getDatabase(), actor, matchCandidateId);
}

/** `reason` istemciden gelir: izin listesinde değilse "belirtilmedi" sayılmaz, reddedilir. */
export async function rejectMatchAction(
  matchCandidateId: number,
  reason: string | null = null,
): Promise<ReviewActionResult> {
  const { actor } = await requireCapability("matching.review");
  if (!isId(matchCandidateId)) return { found: false };
  if (reason !== null && !isReviewReason(reason)) return { found: false };
  return rejectMatch(getDatabase(), actor, matchCandidateId, reason);
}
