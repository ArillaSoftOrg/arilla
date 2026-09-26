"use client";

import { useEffect, useState } from "react";
import actions from "./public-actions.module.css";

export interface NotFoundRecoveryActionsProps {
  homeHref: string;
  homeLabel: string;
  backLabel: string;
  links: readonly {
    href: string;
    label: string;
  }[];
}

export function NotFoundRecoveryActions({
  homeHref,
  homeLabel,
  backLabel,
  links,
}: NotFoundRecoveryActionsProps) {
  const [canGoBack, setCanGoBack] = useState(false);

  useEffect(() => {
    setCanGoBack(window.history.length > 1);
  }, []);

  return (
    <div className={actions.actions}>
      {canGoBack ? (
        <button type="button" className={actions.primary} onClick={() => window.history.back()}>
          {backLabel}
        </button>
      ) : (
        <a href={homeHref} className={actions.primary}>
          {homeLabel}
        </a>
      )}
      {links.map((link) => (
        <a key={link.href} href={link.href} className={actions.secondary}>
          {link.label}
        </a>
      ))}
    </div>
  );
}
