import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Badge.module.css";
import { joinClassNames } from "./layout.ts";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** `neutral` (varsayilan) veya `save`: tasarruf olgusu, `--save` metin. */
  tone?: "neutral" | "save";
  children: ReactNode;
}

export function Badge({ tone = "neutral", className, children, ...rest }: BadgeProps) {
  return (
    <span
      {...rest}
      className={joinClassNames(styles.badge, tone === "save" && styles.save, className)}
    >
      {children}
    </span>
  );
}
