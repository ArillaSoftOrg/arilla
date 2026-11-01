import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Badge.module.css";
import { joinClassNames } from "./layout.ts";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** `brand`: dolgusuz marka etiketi; `save`: tasarruf olgusu. */
  tone?: "neutral" | "save" | "brand";
  children: ReactNode;
}

export function Badge({ tone = "neutral", className, children, ...rest }: BadgeProps) {
  return (
    <span
      {...rest}
      className={joinClassNames(
        styles.badge,
        tone === "save" && styles.save,
        tone === "brand" && styles.brand,
        className,
      )}
    >
      {children}
    </span>
  );
}
