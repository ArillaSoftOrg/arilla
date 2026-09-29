"use client";

import { Button } from "@arilla/ui";
import { useState } from "react";
import styles from "./page.module.css";

/** Davet linkini gosterir ve panoya kopyalar. Pano yoksa link secilebilir kalir. */
export function ReferralLinkClient({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={styles.referralLink}>
      <input
        className={styles.referralInput}
        type="text"
        readOnly
        value={url}
        aria-label="Davet linkin"
        onFocus={(event) => event.currentTarget.select()}
      />
      <Button type="button" variant="secondary" shape="pill" onClick={copy}>
        {copied ? "Kopyalandı" : "Linki kopyala"}
      </Button>
      <span className={styles.srOnly} role="status">
        {copied ? "Davet linki kopyalandı" : ""}
      </span>
    </div>
  );
}
