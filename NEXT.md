# Next

**A-096 — dark-scheme axe across the rest of the staff app.** Next ⬜ in
`docs/prds/06-backlog.md`, row 98. Measured at checkpoint 7 on the seeded book:
**124 nodes on `/staff/clients/[id]`**, 2 on the appointment detail, 2 on the
dashboard drill-down — one value repeated, `text-zinc-500`, 4.6:1 on white and
**4.1:1** on `#0a0a0a`. Playwright's default colour scheme is light and no spec
outside `day-grid.spec.ts` had ever changed it.

**Two things carry over into it.** `emulateMedia` alone is not enough — it flips
the media query on a live page and axe then samples every control
mid-`transition-colors` (583 nodes of blended colours). **Reload.** And the
A-094 backlog note still stands: `cn` was fixed so tailwind-merge stops
discarding A-088's type roles, which means every `Button`, `Field` label,
`EmptyState` and `Tab` in the staff app changed from 16px to A-088's 14/12px and
nobody has *looked* at those screens since. A-096 is the pass that puts eyes on
them.

**A-095 just made those screens worth looking at.** They are no longer empty.
The seeded book now fills all four columns from today onwards, the room axis
actually binds (0 → 39 `no-resource-free` over the same sweep), and `/staff/
waitlist`, `/staff/opened` → "Who wants this slot?", the call-down and
`/staff/dashboard/lapsed` all carry real rows for the first time. An axe run
over a screen with rows on it sees a different screen — which is exactly the
defect checkpoint 7 found twice.

**Also open:** A-097 (row 99, S) — "no preference" falls back to the vanished
stylist's empty column when nobody else is free at that instant. Independent of
A-096.

Read `docs/START-HERE.md` and `CLAUDE.md` first, as always.
