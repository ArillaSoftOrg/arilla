"use client";

import { Button } from "@arilla/ui";
import { useState } from "react";
import styles from "../admin.module.css";

export function CopyLinkClient({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.row}>
      <code className={styles.mono}>{url}</code>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          void navigator.clipboard
            .writeText(url)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? "Kopyalandı" : "Bağlantıyı kopyala"}
      </Button>
    </div>
  );
}
