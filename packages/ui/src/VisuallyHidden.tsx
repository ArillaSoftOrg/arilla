import type { HTMLAttributes, ReactNode } from "react";
import { joinClassNames } from "./layout.ts";
import styles from "./VisuallyHidden.module.css";

export interface VisuallyHiddenProps extends HTMLAttributes<HTMLElement> {
  /** Varsayilan `span`; blok baglaminda `div`, gizli baslik icin `h2`/`h3`. */
  as?: "span" | "div" | "h2" | "h3" | "p";
  children: ReactNode;
}

/** Ekranda gorunmez, ekran okuyucu okur (design.md "Kalite tabanı"). */
export function VisuallyHidden({
  as: Tag = "span",
  className,
  children,
  ...rest
}: VisuallyHiddenProps) {
  return (
    <Tag {...rest} className={joinClassNames(styles.visuallyHidden, className)}>
      {children}
    </Tag>
  );
}
