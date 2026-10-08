import { getEntitlementStatus } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { verifySession } from "../lib/dal.ts";
import styles from "./ara.module.css";
import {
  nextResetLabel,
  SEARCH_RIGHTS_BADGE_LABEL,
  SEARCH_RIGHTS_COPY,
  SEARCH_RIGHTS_HREF,
  searchRightsSummary,
} from "./search-rights-copy.ts";

/**
 * Fotograf/link aramasinin kalan hakki (0047). Yalnizca girisli kullaniciya
 * gosterilir; metin aramasi hak harcamaz. Okuma basarisiz olursa rozet
 * cizilmez, arama sayfasi calismaya devam eder.
 */
export async function SearchRightsBadge() {
  const user = await verifySession();
  if (!user) return null;
  let status: Awaited<ReturnType<typeof getEntitlementStatus>>;
  try {
    status = await getEntitlementStatus(getDatabase(), user.id);
  } catch (error) {
    console.error(
      "[ara] search rights unavailable",
      error instanceof Error ? error.name : "unknown",
    );
    return null;
  }
  return (
    <p className={styles.rights}>
      <span>
        {SEARCH_RIGHTS_BADGE_LABEL}: {searchRightsSummary(status)}
      </span>{" "}
      <span className={styles.rightsHint}>
        {status.exhausted ? SEARCH_RIGHTS_COPY.noRights : nextResetLabel(status.nextResetAt)}{" "}
        <Link href={SEARCH_RIGHTS_HREF}>
          {status.exhausted ? SEARCH_RIGHTS_COPY.earnLink : "Arama hakların"}
        </Link>
      </span>
    </p>
  );
}
