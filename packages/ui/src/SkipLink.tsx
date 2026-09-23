import type { AnchorHTMLAttributes, ReactNode } from "react";
import { joinClassNames } from "./layout.ts";
import styles from "./SkipLink.module.css";

export interface SkipLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /** Atlanacak ogenin id'si; varsayilan `icerik` (design.md: `<main id="icerik">`). */
  targetId?: string;
  /** Baglanti metni - copy.md `nav.skip_to_content`. */
  children: ReactNode;
}

/**
 * Sayfanin ilk odaklanabilir ogesi olarak konur. Klavye odagi gelene kadar
 * gorunmez; odaklaninca sol ustte belirir ve ana icerige atlatir.
 */
export function SkipLink({ targetId = "icerik", className, children, ...rest }: SkipLinkProps) {
  return (
    <a {...rest} href={`#${targetId}`} className={joinClassNames(styles.skipLink, className)}>
      {children}
    </a>
  );
}
