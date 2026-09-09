import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Card.module.css";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Card({ className, children, ...rest }: CardProps) {
  const classes = [styles.card, className].filter(Boolean).join(" ");
  return (
    <div {...rest} className={classes}>
      {children}
    </div>
  );
}
