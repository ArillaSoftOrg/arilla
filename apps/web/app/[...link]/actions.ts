"use server";

import { randomUUID } from "node:crypto";
import { enqueueLinkResolution, getLinkResolutionStatus } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { cookies } from "next/headers";
import { verifySession } from "../lib/dal.ts";

const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** `apps/web/app/ara/gorsel/actions.ts`'teki ile aynı desen. */
async function ensureSessionId(): Promise<string> {
  const store = await cookies();
  const existing = store.get("session_id")?.value;
  if (existing) return existing;

  const sessionId = randomUUID();
  store.set("session_id", sessionId, {
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
  });
  return sessionId;
}

export async function enqueueLinkResolutionAction(urlRaw: string): Promise<{ requestId: string }> {
  const sessionId = await ensureSessionId();
  const user = await verifySession();
  return enqueueLinkResolution(getDatabase(), {
    urlRaw,
    sessionId,
    userId: user?.id ?? null,
  });
}

export interface LinkResolutionPollResult {
  status: "queued" | "processing" | "resolved" | "failed" | "not_found";
  productSlug: string | null;
}

export async function pollLinkResolutionAction(
  requestId: string,
): Promise<LinkResolutionPollResult> {
  const result = await getLinkResolutionStatus(getDatabase(), requestId);
  if (!result) return { status: "not_found", productSlug: null };
  return { status: result.status, productSlug: result.productSlug };
}
