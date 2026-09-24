import type { HTMLAttributes, ReactNode } from "react";
import { gapStyle, joinClassNames, listRole, type SpaceStep } from "./layout.ts";
import styles from "./Stack.module.css";

export interface StackProps extends HTMLAttributes<HTMLElement> {
  /** Ogeler arasi `--space-N` adimi; varsayilan 4 (16px). */
  gap?: SpaceStep;
  /** Yatay hizalama; varsayilan `stretch`. */
  align?: "start" | "center" | "end" | "stretch";
  /**
   * Genel kapsayici ogeleri. Ozel ozniteligi olan ogeler (`form`,
   * `fieldset`) icin Stack'in icine konur, Stack'e donusturulmez.
   */
  as?: "div" | "section" | "article" | "ul" | "ol" | "li";
  children: ReactNode;
}

/** Dikey akis. Ogeler arasi bosluk yalnizca belirtec olceginden gelir. */
export function Stack({
  gap = 4,
  align = "stretch",
  as: Tag = "div",
  className,
  style,
  role,
  children,
  ...rest
}: StackProps) {
  return (
    <Tag
      {...rest}
      role={listRole(Tag, role)}
      className={joinClassNames(styles.stack, styles[`align-${align}`], className)}
      style={gapStyle(gap, style)}
    >
      {children}
    </Tag>
  );
}
