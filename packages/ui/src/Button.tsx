import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "accent";
  children: ReactNode;
}

const VARIANT_CLASSES = {
  primary: "primary",
  secondary: "secondary",
  accent: "accent",
} as const;

export function Button({ variant = "secondary", className, children, ...rest }: ButtonProps) {
  const variantClass = styles[VARIANT_CLASSES[variant]];
  const classes = [styles.button, variantClass, className].filter(Boolean).join(" ");
  return (
    <button type="button" {...rest} className={classes}>
      {children}
    </button>
  );
}
