import type { HTMLAttributes, ReactNode } from "react";
import { joinClassNames } from "./layout.ts";
import styles from "./Section.module.css";

export interface SectionProps extends HTMLAttributes<HTMLElement> {
  /** Dikey bosluk: `default` 48->96px, `compact` 32->64px, `none` 0. */
  spacing?: "default" | "compact" | "none";
  /**
   * HTML ogesi; varsayilan `section`. Erisilebilir bir bolge olmasi icin
   * `section`'a `aria-labelledby` (bolum basliginin id'si) verilmeli.
   */
  as?: "section" | "div" | "article" | "aside";
  children: ReactNode;
}

/**
 * Sayfa bolumunun dikey ritmi. Genislik, zemin veya baslik stili dayatmaz -
 * genislik icin icine `Container` konur.
 */
export function Section({
  spacing = "default",
  as: Tag = "section",
  className,
  children,
  ...rest
}: SectionProps) {
  return (
    <Tag {...rest} className={joinClassNames(styles.section, styles[spacing], className)}>
      {children}
    </Tag>
  );
}
