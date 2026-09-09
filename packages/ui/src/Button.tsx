import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary";
  children: ReactNode;
}

export function Button({ variant = "secondary", className, children, ...rest }: ButtonProps) {
  const variantClass = variant === "primary" ? styles.primary : styles.secondary;
  const classes = [styles.button, variantClass, className].filter(Boolean).join(" ");
  return (
    <button type="button" {...rest} className={classes}>
      {children}
    </button>
  );
}
