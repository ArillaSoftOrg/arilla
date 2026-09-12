"use client";

import { EmptyState } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { enqueueLinkResolutionAction, pollLinkResolutionAction } from "./actions.ts";

const POLL_INTERVAL_MS = 2000;
/** ~30 sn - `docs/architecture.md`'nin "3 saniyelik hedefi" burada geçerli
 * değil (Katman 2 gerçek bir sayfa getirir), ama sonsuza kadar da beklenmez. */
const MAX_POLLS = 15;

export function LinkWaitClient({ urlRaw }: { urlRaw: string }) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let pollCount = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function schedulePoll(requestId: string) {
      timer = setTimeout(async () => {
        if (cancelled) return;
        pollCount += 1;
        const result = await pollLinkResolutionAction(requestId);
        if (cancelled) return;

        if (result.status === "resolved" && result.productSlug) {
          router.push(`/urun/${result.productSlug}`);
          return;
        }
        if (result.status === "failed" || result.status === "not_found" || pollCount >= MAX_POLLS) {
          setFailed(true);
          return;
        }
        schedulePoll(requestId);
      }, POLL_INTERVAL_MS);
    }

    enqueueLinkResolutionAction(urlRaw).then(({ requestId }) => {
      if (!cancelled) schedulePoll(requestId);
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [urlRaw, router]);

  if (failed) {
    return (
      <EmptyState
        title="Bu bağlantıyı çözemedik. Ürünü mağazada açabilirsin."
        action={
          <a href={urlRaw} rel="noopener noreferrer" target="_blank">
            Orijinal bağlantıyı aç
          </a>
        }
      />
    );
  }

  return <EmptyState title="Bu ürünü arıyoruz, birazdan hazır olur." />;
}
