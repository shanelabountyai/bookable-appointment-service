import { occupiesTime } from '@bookable/core/scheduling';
import type { GridColumn, GridItem, GridModel } from '@/lib/day/view-model';
import { statusWord } from './appointment-chip';

/**
 * A-062, redrawn for the design brief at A-093 — THE DAY, ON PAPER (§8.7, §5.4.4).
 *
 * Reached by `?sheet=1` on the SAME route — no new route, no PDF library, no
 * second query: the same `GridModel` the grid renders, in the shape a sheet
 * pinned at a station needs. The grid itself cannot be printed — its chips are
 * absolutely positioned, and a page break through an absolute layout drops
 * rows.
 *
 * It REPLACES the grid rather than hiding beside it. A print-only second copy
 * of the day was the first shape of this, and it broke three A-016 specs the
 * moment it landed: `getByText('Ada Chen')` resolved to two elements, because
 * `display:none` hides a node from the eye and from the a11y tree but not from
 * the DOM. Any future spec on this page would have hit the same landmine.
 *
 * The DATE IS ON EVERY PAGE, in full including the year: yesterday's sheet in
 * the bin looks exactly like today's, and a stylist working from the wrong one
 * is worse than working from none.
 *
 * ── WHAT A-093 CHANGED, AND WHY A LIST IS NOT A SMALLER GRID ───────────────
 *
 * The grid says two things with GEOMETRY that a table cannot say at all: WHEN
 * a row is (its position) and that two rows are AT ONCE (their overlap). Drop
 * to a list and both have to be said in words, or they are not said.
 *
 *  1. THE SORT IS THE ONLY THING HOLDING TIME. Which is how this item found
 *     the defect underneath it: an override at 09:30 printed ABOVE the 09:00
 *     colour it overlaps, because the day view collapsed a segmented
 *     appointment's two blocks to its LAST one (fixed in `day-view.ts`). On
 *     the grid that same bug drew the chip 85 minutes low and nobody had seen
 *     it in three checkpoints; on paper it is a list in the wrong order, which
 *     is the one thing a stylist reading down a page cannot survive.
 *
 *  2. TWO ROWS AT ONE TIME NEED A WORD. Only a staff OVERRIDE can put two
 *     clients in one stylist's hour (D-8's zero-width blocked range is what
 *     lets it past the exclusion constraint), and on the grid the two chips
 *     visibly collide. Here they are consecutive rows, which is the shape of
 *     SEQUENCE — so the marker and the typed reason are on the paper. §5.4.11
 *     calls it the most important visual in the product; it was on the chip
 *     and on none of the eight sheets that come off the printer at 8:45.
 *
 *  3. A ROW THAT IS NOT WHAT IT LOOKS LIKE SAYS SO. The filter is
 *     `occupiesTime`, which deliberately KEEPS `no_show` and `completed` (D-7)
 *     — so the sheet whose comment says it is "who is coming" printed the one
 *     client who definitively is not, in the same ink as everybody else. Every
 *     non-`booked` status now carries the chip's own word, and A-069's
 *     released time carries its sentence: without it, a no-show whose slot was
 *     re-sold prints as two clients in one chair with nothing to separate them.
 *
 *  4. NOTHING IS SAID WITH A GROUND. §4: anything that only works because of a
 *     background colour is invisible on paper. The status word is a WORD, the
 *     override is a WORD IN A BOX, the two note kinds are two glyphs. The
 *     tokens carry it the rest of the way — `@media print` flattens every
 *     ground to white and every ink to black (A-088), which is also why this
 *     file no longer hand-writes `border-black`: that one is invisible on the
 *     screen the desk PREVIEWS the sheet on, which is a tablet in dark mode.
 */
export function DaySheet({
  model,
  columns,
}: {
  model: GridModel;
  columns: GridColumn[];
}) {
  return (
    <div>
      {columns.map((column) => {
        const items = sheetItems(column);
        return (
        <section
          key={column.providerId}
          className='break-after-page last:break-after-auto'
        >
          <table className='w-full border-collapse text-body'>
            {/* WHOSE PAGE THIS IS, INSIDE THE `<thead>` — which is the whole
                reason it is in here and not in a `<header>` above the table.
                A browser repeats `thead` at the top of every printed page and
                repeats nothing else, so a stylist with more than a page of
                clients had page two arrive with the column headings and no
                name and no date on it. Proved on a real PDF: Priya's Wednesday
                is fourteen rows, it breaks after 11:40, and page two opened
                "Time Mins Client" — under a comment in this very file swearing
                the date is on every page. It needs a stylist with a full day
                to appear at all, and every fixture in the suite seeded one
                appointment.

                A `<td>` rather than a `<th colSpan={4}>`: this is a title, not
                a header for the four columns, and a `th` spanning them would
                be announced as one on every cell below. The `<h2>` inside it
                is what carries it to the accessibility tree. */}
            <thead>
              <tr>
                <td colSpan={4} className='border-b-2 border-line-strong pb-1 text-left'>
                  <h2 className='text-section font-bold'>{column.providerName}</h2>
                  <p className='text-body font-normal'>
                    {model.dayLabel} · {model.day}
                    {/* A-093. The hours in words, because the paper has no
                        shaded band: an empty afternoon and an afternoon she is
                        not in are the same blank inches, and one of them is
                        sellable. */}
                    {column.hours.length ? ` · ${column.hours.join(', ')}` : ''}
                    {/* D-22's delta. The sheet is printed at 8:45 and read all
                        day, so it is stamped with what was true when it came
                        off the printer rather than pretending to be live. */}
                    {column.runningLateMinutes
                      ? ` · running ${column.runningLateMinutes} min behind at print`
                      : ''}
                  </p>
                </td>
              </tr>
              {items.length === 0 ? null : (
                <tr className='border-b border-line-strong text-left'>
                  <th className='w-28 py-1 pr-2 font-semibold'>Time</th>
                  <th className='w-16 py-1 pr-2 font-semibold'>Mins</th>
                  <th className='py-1 pr-2 font-semibold'>Client</th>
                  {/* Not "Notes": the notes print in the client's cell, beside
                      the client they are about, and a header naming the empty
                      column after them sent the eye to the wrong half of the
                      page. This column is what it says. */}
                  <th className='w-2/5 py-1 pl-2 font-semibold'>Space to write</th>
                </tr>
              )}
            </thead>
            <tbody>
              {items.length === 0 ? (
                /* A-093. TWO DIFFERENT FACTS, and they were one sentence. A
                   day with nothing booked is a day to sell; a day she is not
                   working is not. `closed` has been on the column since A-016
                   and the paper read the same eight words either way. */
                <tr>
                  <td colSpan={4} className='py-2'>
                    {column.closed ? 'Not working today.' : 'Nothing in the book.'}
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr
                    key={item.key}
                    className='break-inside-avoid border-b border-line-control align-top'
                  >
                    <td className='numeric py-2 pr-2'>{item.time}</td>
                    <td className='numeric py-2 pr-2'>
                      {item.durationMinutes ? `${item.durationMinutes}` : ''}
                    </td>
                    <td className='py-2 pr-2'>
                      <div className='font-semibold'>
                        {item.title}
                        {/* THE WORD, from the chip's own map. On the paper it
                            follows the name rather than floating right: a
                            printed page has no column width to fight over, and
                            "Ada Chen — NO-SHOW" is one thing read once. */}
                        {statusFor(item) ? (
                          <span className='ml-1 text-caption font-semibold uppercase tracking-wide'>
                            — {statusFor(item)}
                          </span>
                        ) : null}
                      </div>
                      {item.detail ? <div>{item.detail}</div> : null}
                      {/* §5.4.11, on paper at last. A box and a word, never a
                          tint — and the reason beside it, which the chip has
                          no room for and which is the whole point of the
                          marker: somebody decided this, and this is why. */}
                      {item.isOverride ? (
                        <div className='mt-0.5'>
                          <span className='rounded-tight border border-current px-1 text-caption font-semibold uppercase tracking-wide'>
                            Override
                          </span>
                          {item.overrideReason ? <span className='ml-1'>{item.overrideReason}</span> : null}
                        </div>
                      ) : null}
                      {/* A-069. Her time went back on the market at this
                          instant, so the client printed against the same hour
                          further down is not a printing error. */}
                      {item.released ? <div>Time given back from {item.released}.</div> : null}
                      {item.pinnedNote ? (
                        <div className='font-semibold'>⚑ {item.pinnedNote}</div>
                      ) : null}
                      {item.missed ? (
                        <div className='font-semibold'>⚑ {item.missed}</div>
                      ) : null}
                      {/* A-070. On the paper at last, and VISUALLY DISTINCT
                          from the pinned note above it — ✎ and italic rather
                          than ⚑ and bold, because one is about her and one is
                          about today, and this sheet is read at arm's length
                          in greyscale. Without it, "patch test done 12/4" and
                          "6.3 + 20 vol" lived on one screen and reached the
                          stylist at the backwash on none. */}
                      {item.visitNote ? <div className='italic'>✎ {item.visitNote}</div> : null}
                    </td>
                    {/* Deliberately empty and deliberately tall: this is where
                        the walk-in, the colour formula and 'back at 3' get
                        written. A sheet with no room to write on is a sheet
                        that gets a Post-it stuck to it. */}
                    <td className='h-16 border-l border-line-control' />
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
        );
      })}
    </div>
  );
}

/** The chip's word, and only for an appointment: a break has no status and
 *  "Break — booked" is a sentence about nothing. */
function statusFor(item: GridItem): string | null {
  return item.status ? statusWord(item.status) : null;
}

/**
 * What belongs on the paper: breaks and time off (the stylist plans around
 * them) and every appointment that still OCCUPIES its slot.
 *
 * The cancelled filter asks `occupiesTime`, the same reader the busy-set query
 * and the constraint predicate derive from — so a ninth status cannot quietly
 * appear on the sheet, or quietly vanish from it. Gaps are left off: the
 * scribble column is the free space, and printing '45 min free' twice a page
 * only costs rows.
 */
function sheetItems(column: GridColumn) {
  return column.items.filter(
    (item) =>
      item.kind !== 'gap' &&
      (item.status === undefined || occupiesTime(item.status)),
  );
}
