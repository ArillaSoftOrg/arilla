"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { LoginGateModal } from "../../login-gate-modal-client.tsx";
import { SEARCH_RIGHTS_COPY, SEARCH_RIGHTS_HREF } from "../search-rights-copy.ts";
import { pollLinkSearchAction, startLinkSearchAction } from "./actions.ts";
import linkStyles from "./link-search.module.css";
import { LINK_SEARCH_COPY, linkFailureCopy } from "./link-search-copy.ts";

const POLL_INTERVAL_MS = 1500;
/**
 * Bekleme üst sınırı. Worker'ın tek sayfa süresi 20 sn + görsel embedding'i;
 * 60 sn'de hâlâ bitmediyse kullanıcıya söylenir. Sonsuz bekleme yok.
 */
const CLIENT_TIMEOUT_MS = 60_000;

type Phase = { kind: "waiting" } | { kind: "timeout" } | { kind: "failed"; errorCode: string };

function LinkSearchStatusCard({
  site,
  title,
  description,
  marker = "→",
  action,
}: {
  site: string;
  title: string;
  description: string;
  marker?: string;
  action?: ReactNode;
}) {
  return (
    <section className={linkStyles.waitShell} aria-labelledby="link-search-title">
      <div className={linkStyles.waitCard}>
        <div className={linkStyles.waitVisual} aria-hidden="true">
          <div className={linkStyles.waitPanel}>
            <span className={linkStyles.waitSite}>{site}</span>
            <span className={linkStyles.waitPulse}>{marker}</span>
          </div>
        </div>
        <div className={linkStyles.waitCopy}>
          <h1 className={linkStyles.waitTitle} id="link-search-title" role="status">
            {title}
          </h1>
          <p className={linkStyles.waitDescription}>{description}</p>
        </div>
        {action ? <div className={linkStyles.waitActions}>{action}</div> : null}
      </div>
    </section>
  );
}

export function LinkSearchWaitClient({ url, site }: { url: string; site: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "waiting" });
  // Deneme basina tek istek anahtari (0046): efekt iki kez calissa da
  // (Strict Mode, yeniden cizim) sunucu ayni denemeyi ikinci kez ucretlendirmez.
  const [attempt, setAttempt] = useState(() => ({ key: crypto.randomUUID() }));
  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + CLIENT_TIMEOUT_MS;

    function poll(requestId: string) {
      timer = setTimeout(async () => {
        if (cancelled) return;
        let result: Awaited<ReturnType<typeof pollLinkSearchAction>>;
        try {
          result = await pollLinkSearchAction(requestId);
        } catch {
          result = { state: "pending" };
        }
        if (cancelled) return;
        if (result.state === "resolved") {
          // Sonucu sunucu sayfası çizer; geçmişe yeni kayıt eklenmez.
          router.refresh();
          return;
        }
        if (result.state === "failed") {
          setPhase({ kind: "failed", errorCode: result.errorCode });
          return;
        }
        if (Date.now() > deadline) {
          setPhase({ kind: "timeout" });
          return;
        }
        poll(requestId);
      }, POLL_INTERVAL_MS);
    }

    startLinkSearchAction(url, attempt.key)
      .then((started) => {
        if (cancelled) return;
        if (started.status === "failed") {
          if (started.errorCode === "login_required") setLoginOpen(true);
          setPhase({ kind: "failed", errorCode: started.errorCode });
        } else poll(started.requestId);
      })
      .catch(() => {
        if (!cancelled) setPhase({ kind: "failed", errorCode: "unexpected" });
      });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [url, router, attempt]);

  function retry() {
    setPhase({ kind: "waiting" });
    setAttempt({ key: crypto.randomUUID() });
  }

  if (phase.kind === "failed") {
    const copy = linkFailureCopy(phase.errorCode);
    const retryable = phase.errorCode === "retry" || phase.errorCode === "busy";
    return (
      <>
        <LoginGateModal open={loginOpen} onClose={() => setLoginOpen(false)} />
        <LinkSearchStatusCard
          site={site}
          title={copy.title}
          description={copy.description}
          marker="!"
          action={
            phase.errorCode === "login_required" ? (
              <Button type="button" variant="primary" onClick={() => setLoginOpen(true)}>
                Giriş yap
              </Button>
            ) : phase.errorCode === "no_rights" ? (
              <a href={SEARCH_RIGHTS_HREF}>{SEARCH_RIGHTS_COPY.earnLink}</a>
            ) : retryable ? (
              <Button type="button" variant="primary" onClick={retry}>
                {LINK_SEARCH_COPY.retry}
              </Button>
            ) : undefined
          }
        />
      </>
    );
  }

  if (phase.kind === "timeout") {
    return (
      <LinkSearchStatusCard
        site={site}
        title={LINK_SEARCH_COPY.timeoutTitle}
        description={LINK_SEARCH_COPY.timeoutDescription}
        marker="!"
        action={
          <Button type="button" variant="primary" onClick={retry}>
            {LINK_SEARCH_COPY.retry}
          </Button>
        }
      />
    );
  }

  return (
    <LinkSearchStatusCard
      site={site}
      title={LINK_SEARCH_COPY.pendingTitle}
      description={LINK_SEARCH_COPY.pendingDescription}
    />
  );
}
