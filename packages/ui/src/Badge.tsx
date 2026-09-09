import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Badge.module.css";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
}

export function Badge({ className, children, ...rest }: BadgeProps) {
  const classes = [styles.badge, className].filter(Boolean).join(" ");
  return (
    <span {...rest} className={classes}>
      {children}
    </span>
  );
}
