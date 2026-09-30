'use client';

import { createContext, useContext, useEffect, useState, useTransition } from 'react';
import { printDaySheet } from '@/lib/day/actions';
import { Button } from '@/components/ui/button';

/**
 * A-150 (C9, D-73) — PRINT, AND SAY WHEN ON THE PAPER.
 *
 * The button records the print first and prints second, so "Printed 08:45 by
 * Sam" on every page is the same instant the screen counts "changed since
 * print" from. A browser's own Print menu still works and records nothing —
 * that paper carries no stamp, which is honest: nobody knows when it was made.
 */
const Stamp = createContext<string | null>(null);

export function SheetPrint({
  day,
  providerId,
  children,
}: {
  day: string;
  providerId: string | null;
  children: React.ReactNode;
}) {
  // `n` so a second press in the same minute (same text) still prints.
  const [stamp, setStamp] = useState<{ text: string; n: number } | null>(null);
  const [pending, start] = useTransition();

  // After the stamp has RENDERED, never before — printing from the click
  // handler would print the page as it was before the stamp arrived.
  useEffect(() => {
    if (stamp) window.print();
  }, [stamp]);

  return (
    <Stamp.Provider value={stamp?.text ?? null}>
      <div className="mb-4 print:hidden">
        <Button type="button" pending={pending} onClick={() =>
            start(async () => {
              const text = await printDaySheet(day, providerId);
              setStamp((prev) => ({ text, n: (prev?.n ?? 0) + 1 }));
            })
          }>
          Print
        </Button>
      </div>
      {children}
    </Stamp.Provider>
  );
}

export function PrintedStamp() {
  const stamp = useContext(Stamp);
  return stamp ? <> · {stamp}</> : null;
}
