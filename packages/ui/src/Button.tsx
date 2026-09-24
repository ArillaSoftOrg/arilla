import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";
import { joinClassNames } from "./layout.ts";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * - `primary`: onay/kaydetme gibi olumlu birincil eylem (`--save` zemini).
   * - `secondary`: varsayilan, ikincil eylem (`--line-strong` sinirli).
   * - `accent`: notr birincil eylem (`--accent`, karar 0025).
   * - `ghost`: kenarliksiz, zeminsiz ucuncul eylem (ikon dugmesi, "Tumunu gor").
   */
  variant?: "primary" | "secondary" | "accent" | "ghost";
  /** `md` (varsayilan, 44px) veya `lg` (hero/form ana eylemi, 52px). */
  size?: "md" | "lg";
  /** Hap bicimi (`--radius-pill`); varsayilan `--radius-md`. */
  shape?: "rounded" | "pill";
  /** Kapsayicinin tam genisligi (mobil form eylemi). */
  fullWidth?: boolean;
  children: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  shape = "rounded",
  fullWidth = false,
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = joinClassNames(
    styles.button,
    styles[variant],
    size === "lg" && styles.lg,
    shape === "pill" && styles.pill,
    fullWidth && styles.fullWidth,
    className,
  );
  return (
    <button type="button" {...rest} className={classes}>
      {children}
    </button>
  );
}
