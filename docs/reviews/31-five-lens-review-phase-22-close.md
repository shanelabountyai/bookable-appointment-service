# Five-lens review: Phase 22 close

**Run 2026-10-01 at `b946407`, after A-152 closed Phase 22 and emptied the backlog.**

The same five reviewers as review 30 ran in parallel, each one read-only. No app was started, no database was touched, and no file was changed. Each lens re-checked the bundles it raised in review 30 against the code rather than the write-ups, then audited what the rest of Phase 22 added.

| Lens | Agent | Owned | Verdicts |
|---|---|---|---|
| Owner / operator | `salon-operator` | C5, C10, C11 | C5 holds with gap · C10 holds with gap · **C11 defect** |
| One column, behind the chair | `stylist` | C1, C8, C9 | C1 holds · C8 holds with gap · C9 holds with gap |
| Client on a 390px phone | `booking-client` | C2, C3 | both hold with gap |
| Coherence, hierarchy, copy | `ux-design` | C7 | holds with gap |
| Keyboard, screen reader, WCAG 2.2 | `accessibility` | C4, C6 | C4 holds with gap · **C6 defect** |

## 1. Verdict

**Every bundle shipped what it asked for. The defects are in what each one did next.** Phase 22's late items added three new kinds of result that remove themselves from the screen, two new lists whose rows open on the wrong person or the wrong week, and a change marker that skips two existing ways to change a row. This is CLAUDE.md's "a state change is never one edit" rule again: A-150's `CHANGE_TYPES` even carries the warning in a comment, and two existing writers were still left out of it.

## 2. Verified before writing

| Claim | Evidence | Holds? |
|---|---|---|
| Extend books the series' ORIGINAL provider | `packages/db/booking/series.ts:266,310` reads `series.providerId`. The only other writers of `AppointmentSeries` are the merge (`clients.ts:449`) and `endedAt` (`end-series.ts:236`). | ✔ |
| The 15 s refresh pulls focus to a column heading | `day-grid.tsx:55-64`: runs on every `model`, guards only `activeElement === body`, falls back to `columns[0]`. | ✔ |
| `StatusActions` drops its own live region | `status-actions.tsx:48` `if (moves.length === 0) return null`. | ✔ |
| A stale lost-race message returns after Back | `booking-flow.tsx` `lostRace = step === 'time' && result && !result.ok`; details-step Back does not clear `result`. | ✔ |
| "Worked" prints the buffered envelope | `view-model.ts:469` formats `appointment.blocks` (from `blockedStart/End`); `segments.spec.ts:209` pins `Worked 09:50–10:45 · 11:25–12:20` against a 10:00–12:00 row. | ✔ |
| Services and client changes are not "changed" | `packages/db/day/changes.ts:25` omits `services_changed` and `client_changed`. | ✔ |

The rest is the reviewer's reading, with its file:line.

## 3. Candidate bundles

### Defects: small and certain

| # | Bundle | Size | From | Contents |
|---|---|---|---|---|
| **E1** | **Series extend and "never booked" tell the truth** | S–M | operator #1, #4, #5; a11y #4 | • Extend takes provider (and wall time if cheap) from the latest occurrence, as it already does services. The list row shows that provider.<br>• "Never booked" hides past days, weeks after `endedAt`, and weeks where the client already has an active appointment that day. The fuller fix carries series and ordinal through the "Book this week" write.<br>• The extend result survives its row leaving the list (render it outside the list, or redirect), and takes focus. Axe-scan the populated page in both schemes (A-096). |
| **E2** | **Results that remove themselves** | S–M | a11y #2, #3; booking-client #2 | • `StatusActions` always renders its live region; only the buttons go.<br>• A contact-save match is announced (`contact-form.tsx:57`).<br>• Manage cancel and confirm: a polite region in `Shell`, or focus the new status line. "Book again" on terminal states.<br>• **Guard:** the A-145 parse test also matches `role="status"`/`"alert"` and flags `return null` in a component that holds a live region. |
| **E3** | **Focus recovery only when focus was actually lost** | S | a11y #1; stylist C1 gap | • Record the focused element, recover only when it is disconnected. No `columns[0]` fallback.<br>• The same recovery on `provider-day.tsx`, which now refreshes too.<br>• **Guard:** an e2e that leaves focus on `<body>` across a refresh and asserts it is not moved. |
| **E4** | **Worked blocks print the worked time** | S | stylist #1 | Clamp the first block to `startAt` and the last to `endAt`. Assert `Worked 10:00–10:45 · 11:25–12:00`, both edges of each block (A-093). |
| **E5** | **Owed rebook does not open on the absent provider's day** | S | operator #2 | When the original day is still ahead, open in `provider=any` on that day, or start the next day. The A-151 e2e currently asserts the wrong thing. |
| **E6** | **/book small fixes** | XS | booking-client #1, #6 | Clear `result` on the details-step Back (or require `result.alternatives` for `lostRace`). `aria-pressed` on the time buttons. |
| **E7** | **`saveClientNotes` locks the row** | XS | operator #6 | `SELECT … FOR UPDATE` on the client at the start of the transaction, so two saves in the same instant cannot both pass the stale check. |

### Next tier

| # | Bundle | Size | From | Contents |
|---|---|---|---|---|
| **N1** | **"Changed" counts every change in place** | S | stylist #3, #5 | Add `services_changed` (`Now ends 16:30 · Sam · 11:02`) and `client_changed`. Changed-since-print counts active rows only. **Needs a decision beside D-73**, not a re-open of it. |
| **N2** | **Note and contact history can be read** | S | operator #3 | A collapsed "Earlier versions" list on the client page from `ClientNoteVersion`. Contact edits leave a trail (the phone is where reminders go). |
| **N3** | **The processing chip leads with the facts** | S | stylist #2, #4 | `40 min · back 11:25 · Robin Colour`, with a `scrollWidth`/`clientWidth` assertion on a long fixture name (A-120). The booking made into a gap says so on its own row. |
| **N4** | **Design system on A-146's screens, and the naming leftovers** | S | ux #1–#3, #5, #6 | `Field`/`Button`/tokens on `contact-form.tsx`, `notes-form.tsx`, `clients/[id]/page.tsx`. The five "stylist" staff strings become "provider". One name for owed (nav vs h1). "Show" on `/staff/series` is secondary. Manage h1 uses `text-page-title`. |
| **N5** | **Staff keyboard leftovers** | S | a11y #5–#7 | Now marker inside the `<ol>` with `Now, 14:05`; `Jump to now, {provider}`. A refusal focuses the "Book it anyway" checkbox, with its reasons wired by `aria-describedby`. `aria-describedby` on the notes textarea. The chip's no-link `aria-label` span (`appointment-chip.tsx:224`). |
| **N6** | **Manage reschedule on a phone** | S | booking-client #3, #5, #7 | `min-h-11 text-base` on the select and time labels. Reset after a successful move so a double tap cannot move twice. Done-screen copy does not promise an email that was never given. |
| **N7** | **Now / next on the provider list** | S | stylist (C14 split) | The list's own "jump to now". The PIN half of C14 stays a candidate. |

### Carried candidates

| # | Bundle | Call |
|---|---|---|
| **C12** | Undo a mis-tapped forward status move | **Both operator and stylist rank it first.** A wrong Finish seeds the D-64 cascade, and D-73 keeps status taps off the change marker, so the screen names nobody. The stylist asks for the actor on the undo ("Finished by Sam · 11:02 · Undo"). Amends §7, so it needs a decision. |
| **C16** | "Book with *name*" copy | Still needed, XS. "Book an appointment", with "Ask for {name} on the next step." Do not re-open prefill. |
| — | Manage page inside the cutoff | Cancel shows but silently becomes a late cancel. A neutral line is possible without breaking TOKEN-03. Touches D-10, so owner call; the reviewer does not recommend a re-open. |
| C13, C14 (PIN), C15 | | Stay recorded candidates. The operator ranks them below C12 and C16, and recommends not building them. |

## 4. The operator's close call

Not yet. One short phase of the certain defects, plus C12 and C16, then close.
