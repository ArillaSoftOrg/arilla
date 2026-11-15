"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { HOME_CATEGORY_OPTIONS, type HomeCategoryId } from "./home-category-config.ts";
import styles from "./home-search-composer.module.css";

export {
  DEFAULT_HOME_CATEGORY,
  HOME_CATEGORY_OPTIONS,
  type HomeCategoryId,
} from "./home-category-config.ts";

function optionIndex(id: HomeCategoryId): number {
  return Math.max(
    0,
    HOME_CATEGORY_OPTIONS.findIndex((option) => option.id === id),
  );
}

export function HomeCategoryPicker({
  value,
  onChange,
}: {
  value: HomeCategoryId;
  onChange: (value: HomeCategoryId) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = optionIndex(value);
  const selected = HOME_CATEGORY_OPTIONS[selectedIndex] ?? HOME_CATEGORY_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    optionRefs.current[selectedIndex]?.focus({ preventScroll: true });

    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, selectedIndex]);

  function focusOption(index: number) {
    const length = HOME_CATEGORY_OPTIONS.length;
    optionRefs.current[(index + length) % length]?.focus({ preventScroll: true });
  }

  function handleOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOption(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOption(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusOption(HOME_CATEGORY_OPTIONS.length - 1);
    }
  }

  return (
    <div ref={rootRef} className={styles.categoryPicker}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.categoryTrigger}
        aria-label="Alışveriş kategorisi"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <span>{selected.label}</span>
        <span className={styles.categoryChevron} aria-hidden="true" />
      </button>

      {open ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Kategori seç"
          className={styles.categoryListbox}
        >
          {HOME_CATEGORY_OPTIONS.map((option, index) => (
            <button
              key={option.id}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              role="option"
              aria-selected={option.id === value}
              className={styles.categoryOption}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
              onClick={() => {
                onChange(option.id);
                setOpen(false);
                triggerRef.current?.focus({ preventScroll: true });
              }}
            >
              <span>{option.label}</span>
              {option.id === value ? (
                <span className={styles.categoryCheck} aria-hidden="true">
                  ✓
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
