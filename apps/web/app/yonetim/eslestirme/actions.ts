"use server";

import { approveMatch, rejectMatch } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { requireRole } from "../../lib/dal.ts";

export interface ReviewActionResult {
  found: boolean;
}

export async function approveMatchAction(matchCandidateId: number): Promise<ReviewActionResult> {
  await requireRole(["moderator", "admin"]);
  return approveMatch(getDatabase(), matchCandidateId);
}

export async function rejectMatchAction(matchCandidateId: number): Promise<ReviewActionResult> {
  await requireRole(["moderator", "admin"]);
  return rejectMatch(getDatabase(), matchCandidateId);
}
