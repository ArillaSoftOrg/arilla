import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Container.module.css";
import { joinClassNames } from "./layout.ts";

/** docs/design.md "Düzen ve kapsayıcılar": bes icerik genisligi. */
export type ContainerSize = "compact" | "reading" | "comparison" | "standard" | "wide";

export interface ContainerProps extends HTMLAttributes<HTMLElement> {
  /** Icerik alaninin `max-width`'i; varsayilan `standard` (960px). */
  size?: ContainerSize;
  /** Kapsayicinin HTML ogesi; varsayilan `div`. */
  as?: "div" | "main" | "header" | "footer" | "nav" | "section" | "article";
  children: ReactNode;
}

/**
 * Icerigi ortalar, `max-width`'i belirtecten alir ve yatay `--gutter`
 * (16/24/32px) uygular. Gorsel stil (zemin, kenarlik) tasimaz.
 */
export function Container({
  size = "standard",
  as: Tag = "div",
  className,
  children,
  ...rest
}: ContainerProps) {
  return (
    <Tag {...rest} className={joinClassNames(styles.container, styles[size], className)}>
      {children}
    </Tag>
  );
}
