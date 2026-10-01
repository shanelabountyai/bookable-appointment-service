"use client";

import { useEffect, useRef, type FocusEvent, type ReactNode } from "react";

/**
 * A-155 — recover focus only when focus was LOST. A refresh can unmount the
 * button the desk just tapped (§7 moved it on), and the browser drops focus to
 * `<body>`. We record the focused element and its "home" (an element id that
 * survives the refresh); after any render, if the recorded element is
 * disconnected AND nothing else holds focus, focus goes home. Focus that was
 * already on `<body>`, or anywhere live, is never moved — there is no "first
 * column" fallback to yank a reader somewhere they never were.
 */
export function useFocusRecovery(
  homeOf: (target: HTMLElement) => string | null,
) {
  const last = useRef<{ el: HTMLElement; homeId: string } | null>(null);
  useEffect(() => {
    const rec = last.current;
    if (!rec || rec.el.isConnected) return;
    last.current = null;
    if (document.activeElement === document.body)
      document.getElementById(rec.homeId)?.focus();
  });
  return (event: FocusEvent) => {
    const el = event.target as HTMLElement;
    const homeId = homeOf(el);
    last.current = homeId ? { el, homeId } : null;
  };
}

/** Same recovery for server-rendered lists; each focusable home carries an id. */
export function FocusRecovery({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const onFocusCapture = useFocusRecovery(
    (el) => el.closest<HTMLElement>("[data-focus-home]")?.id ?? null,
  );
  return (
    <div onFocusCapture={onFocusCapture} className={className}>
      {children}
    </div>
  );
}
