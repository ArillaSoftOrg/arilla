"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { clearHistoryAction } from "./actions.ts";

export function ClearHistoryButtonClient() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleClick() {
    setPending(true);
    try {
      await clearHistoryAction();
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <Button type="button" variant="secondary" disabled={pending} onClick={handleClick}>
      Geçmişi sil
    </Button>
  );
}
