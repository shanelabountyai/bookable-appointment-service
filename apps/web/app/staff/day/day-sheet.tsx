import { occupiesTime } from '@bookable/core/scheduling';
import type { GridColumn, GridModel } from '@/lib/day/view-model';

/**
 * A-062 — the day, on paper, one stylist per page.
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
      {columns.map((column) => (
        <section
          key={column.providerId}
          className='break-after-page last:break-after-auto'
        >
          <header className='mb-2 border-b-2 border-black pb-1'>
            <h2 className='text-lg font-bold'>{column.providerName}</h2>
            <p className='text-sm'>
              {model.dayLabel} · {model.day}
              {/* D-22's delta. The sheet is printed at 8:45 and read all day,
                  so it is stamped with what was true when it came off the
                  printer rather than pretending to be live. */}
              {column.runningLateMinutes
                ? ` · running ${column.runningLateMinutes} min behind at print`
                : ''}
            </p>
          </header>

          {sheetItems(column).length === 0 ? (
            <p className='text-sm'>Nothing in the book.</p>
          ) : (
            <table className='w-full border-collapse text-sm'>
              <thead>
                <tr className='border-b border-black text-left'>
                  <th className='w-28 py-1 pr-2 font-semibold'>Time</th>
                  <th className='w-16 py-1 pr-2 font-semibold'>Mins</th>
                  <th className='py-1 pr-2 font-semibold'>Client</th>
                  <th className='w-2/5 py-1 pl-2 font-semibold'>Notes</th>
                </tr>
              </thead>
              <tbody>
                {sheetItems(column).map((item) => (
                  <tr
                    key={item.key}
                    className='break-inside-avoid border-b border-zinc-500 align-top'
                  >
                    <td className='py-2 pr-2 font-mono'>{item.time}</td>
                    <td className='py-2 pr-2'>
                      {item.durationMinutes ? `${item.durationMinutes}` : ''}
                    </td>
                    <td className='py-2 pr-2'>
                      <div className='font-semibold'>{item.title}</div>
                      {item.detail ? <div>{item.detail}</div> : null}
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
                    <td className='h-16 border-l border-zinc-500' />
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </div>
  );
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
