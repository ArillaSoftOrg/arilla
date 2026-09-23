import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Cluster.module.css";
import { gapStyle, joinClassNames, listRole, type SpaceStep } from "./layout.ts";

export interface ClusterProps extends HTMLAttributes<HTMLElement> {
  /** Ogeler arasi (yatay ve dikey) `--space-N` adimi; varsayilan 2 (8px). */
  gap?: SpaceStep;
  /** Dikey hizalama; varsayilan `center`. */
  align?: "start" | "center" | "end" | "baseline" | "stretch";
  /** Yatay dagilim; varsayilan `start`. */
  justify?: "start" | "center" | "end" | "between";
  /** Satir dolunca alt satira sarilir; varsayilan `true`. */
  wrap?: boolean;
  as?: "div" | "ul" | "ol" | "nav" | "li";
  children: ReactNode;
}

/** Yatay, sarilabilen akis (buton grubu, chip satiri, meta satiri). */
export function Cluster({
  gap = 2,
  align = "center",
  justify = "start",
  wrap = true,
  as: Tag = "div",
  className,
  style,
  role,
  children,
  ...rest
}: ClusterProps) {
  return (
    <Tag
      {...rest}
      role={listRole(Tag, role)}
      className={joinClassNames(
        styles.cluster,
        styles[`align-${align}`],
        styles[`justify-${justify}`],
        wrap ? styles.wrap : styles.nowrap,
        className,
      )}
      style={gapStyle(gap, style)}
    >
      {children}
    </Tag>
  );
}
