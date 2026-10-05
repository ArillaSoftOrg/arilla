"use client";

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { logoutAction } from "../cikis-actions.ts";
import { DeleteAccountConfirmClient } from "./delete-account-button-client.tsx";
import styles from "./page.module.css";

/**
 * "Yönet" menüsü: yalnızca Hesabı sil ve Çıkış yap. Çıkış mevcut
 * `logoutAction` (düz form + server action, JS'siz de POST ile çalışır).
 * Hesap silme mevcut onay akışını açar; "tüm cihazlardan çıkış" bilerek
 * burada yok. Klavye: Aşağı/Yukarı/Home/End gezinir, Esc kapatıp odağı
 * düğmeye döndürür, Tab menüyü kapatır.
 */
export function ManageMenuClient() {
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function items(): HTMLElement[] {
    return Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  }

  function openAndFocus(which: "first" | "last") {
    setOpen(true);
    requestAnimationFrame(() => {
      const list = items();
      (which === "first" ? list[0] : list[list.length - 1])?.focus();
    });
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openAndFocus("first");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openAndFocus("last");
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const list = items();
    const current = list.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      event.preventDefault();
      list[(next + list.length) % list.length]?.focus();
    };
    if (event.key === "ArrowDown") move(current + 1);
    else if (event.key === "ArrowUp") move(current - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "Tab") setOpen(false);
  }

  return (
    <div className={styles.manage} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.manageButton}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onTriggerKeyDown}
      >
        Yönet
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Hesap işlemleri"
          className={styles.menu}
          onKeyDown={onMenuKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              setOpen(false);
              setConfirmingDelete(true);
            }}
          >
            Hesabı sil
          </button>
          <form action={logoutAction} role="none">
            <button type="submit" role="menuitem" className={styles.menuItem}>
              Çıkış yap
            </button>
          </form>
        </div>
      ) : null}
      {confirmingDelete ? (
        <DeleteAccountConfirmClient
          onCancel={() => {
            setConfirmingDelete(false);
            triggerRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
