import { requireStaff } from '@/lib/auth/session';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { Tab, Tabs } from '@/components/ui/tabs';
import { PX_PER_MINUTE } from '@/lib/day/scale';
import type { GridItem } from '@/lib/day/view-model';
import { CallMarkButtons } from '@/components/call-mark-buttons';
import { ATTEMPT_WORDS } from '@/lib/appointments/attempt-words';
import { recordAttempt } from '@/lib/appointments/call-down-actions';
import { recordOffer } from '@/lib/waitlist/offer-actions';
import { OFFER_WORDS } from '@/lib/waitlist/offer-words';
import { AppointmentChip } from '../day/appointment-chip';
import { DayGrid } from '../day/day-grid';
import { FreedSlotRow } from '../opened/freed-slot-row';
import { FIXTURE_ZONE, FREED_SLOTS } from './opened-fixtures';
import {
  A_STYLIST_OFF,
  FOUR_STYLISTS,
  MODIFIER_MATRIX,
  ONE_STYLIST,
  RUNNING_FORTY_LATE,
  STATUS_MATRIX,
} from './day-fixtures';

/**
 * A-089 — THE STATE MATRIX, AS A PAGE (design brief §8.2).
 *
 * §8.2 asks for "every state drawn: rest, hover, focus, active, disabled,
 * pending, invalid". Three of those seven are CSS pseudo-classes and cannot be
 * drawn by rendering markup — so this page renders the four that are props
 * (rest, disabled, pending, invalid) and `e2e/design-system.spec.ts` DRIVES
 * the other three, which is the only way to assert a focus ring exists rather
 * than to believe a screenshot.
 *
 * It is also what gives the primitives a caller and therefore an axe run
 * before A-085 adopts them across the shell — the backlog row's own argument
 * for building a subset ("a primitive with no caller has no state matrix
 * anybody has checked") applies to this item too, and a gallery is the
 * cheapest honest answer to it. No Storybook: §9 forbids a new client-side
 * dependency, and a route the suite can already log into and axe costs
 * nothing.
 *
 * Behind `requireStaff()` like every other staff route, and deliberately
 * unlinked — it is a workbench, not a screen the desk needs.
 */
export const dynamic = 'force-dynamic';

/** Every control on this page has a UNIQUE accessible name — `rest primary`,
 *  `disabled primary`, `Saving primary…`. Four variants × three states is
 *  twelve buttons, and the first draft named the rest and disabled rows
 *  identically: the spec's `getByRole` then matched two elements and failed
 *  strict mode, which is the gallery telling the truth about itself. */
const VARIANTS = ['primary', 'secondary', 'quiet', 'destructive'] as const;

export default async function DesignPage() {
  await requireStaff();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 p-8">
      <div>
        <h1 className="text-page-title font-semibold tracking-tight">Primitives</h1>
        {/* A plain paragraph, NOT `EmptyState`: this page is not empty, and a
            primitive used for its look rather than its meaning is a primitive
            whose name has started lying. */}
        <p className="mt-1 text-body text-ink-muted">
          The states that are props are drawn here; hover, focus and active are driven by the e2e
          spec.
        </p>
      </div>

      <section className="flex flex-col gap-4">
        <h2 className="text-section font-semibold">Button</h2>
        {(['rest', 'disabled', 'pending'] as const).map((state) => (
          <div key={state} className="flex flex-wrap items-center gap-3">
            <span className="w-20 text-caption text-ink-muted">{state}</span>
            {VARIANTS.map((variant) => (
              <Button
                key={variant}
                variant={variant}
                disabled={state === 'disabled'}
                pending={state === 'pending'}
              >
                {state === 'pending' ? `Saving ${variant}…` : `${state} ${variant}`}
              </Button>
            ))}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-20 text-caption text-ink-muted">compact</span>
          {VARIANTS.map((variant) => (
            <Button key={variant} variant={variant} size="compact">
              compact {variant}
            </Button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-section font-semibold">Link as button, with counts</h2>
        <div className="flex flex-wrap items-center gap-3">
          {VARIANTS.map((variant) => (
            <LinkButton key={variant} href="/staff/design" variant={variant}>
              {variant}
            </LinkButton>
          ))}
        </div>
        {/* The badge INSIDE the control that names it — a bare "3" beside a
            label announces "3". */}
        <div className="flex flex-wrap items-center gap-3">
          <LinkButton href="/staff/design">
            Opened up <Badge>3</Badge>
          </LinkButton>
          <LinkButton href="/staff/design">
            Still open <Badge>12</Badge>
          </LinkButton>
          <LinkButton href="/staff/design">
            Messages <Badge intent="attention">2</Badge>
          </LinkButton>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-section font-semibold">Field</h2>
        <Field id="demo-rest" label="Rest">
          {(control) => <Input {...control} name="rest" placeholder="Name or phone number" />}
        </Field>
        <Field id="demo-hint" label="With a hint" hint="The last few digits are enough.">
          {(control) => <Input {...control} name="hint" />}
        </Field>
        <Field
          id="demo-invalid"
          label="Invalid"
          hint="The last few digits are enough."
          error="That number is already on another record."
        >
          {(control) => <Input {...control} name="invalid" defaultValue="512" />}
        </Field>
        <Field id="demo-hidden" label="Hidden label" labelHidden>
          {(control) => <Input {...control} name="hidden" placeholder="Label is screen-reader only" />}
        </Field>
        <Field id="demo-disabled" label="Disabled">
          {(control) => <Input {...control} name="disabled" disabled defaultValue="Locked" />}
        </Field>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-section font-semibold">Tabs</h2>
        <Tabs label="Primitive demo view">
          <Tab href="/staff/design" current>
            Everyone
          </Tab>
          <Tab href="/staff/design?who=dana">Dana</Tab>
          <Tab href="/staff/design?who=marisol">Marisol</Tab>
        </Tabs>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-section font-semibold">Empty state</h2>
        <EmptyState>Nobody matches “Kerr”.</EmptyState>
      </section>

      {/* ==================================================================
          A-090 — the domain components (§5.4.1–3), drawn as matrices.
          ================================================================== */}

      <section className="flex flex-col gap-4">
        <h2 className="text-section font-semibold">Appointment chip — the eight statuses</h2>
        <p className="text-body text-ink-muted">
          Every one carries its status as a WORD as well as a colour (§4). <strong>Booked</strong> is
          the only one with no word, because it is most of every column and a marker on all of them is
          a marker on none. The stripe down the left edge is graphical and carries the 3:1 bar; the
          word carries the meaning.
        </p>
        <div className="flex flex-wrap gap-3">
          {STATUS_MATRIX.map((item) => (
            <ChipBox key={item.key} item={item} />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-section font-semibold">Appointment chip — the modifiers</h2>
        <p className="text-body text-ink-muted">
          One at a time rather than all at once, which is the only composition that never happens in a
          salon. Each is a glyph or a word, never a tint: they have to survive greyscale on the printed
          sheet and a colour-blind reader on the tablet.
        </p>
        <div className="flex flex-wrap gap-3">
          {MODIFIER_MATRIX.map(({ caption, item }) => (
            <div key={item.key} className="flex flex-col gap-1">
              <span className="text-caption text-ink-muted">{caption}</span>
              <ChipBox item={item} />
            </div>
          ))}
        </div>
      </section>

      {/* ==================================================================
          A-091 — §8.6 and §5.4.9.
          ================================================================== */}

      <section className="flex flex-col gap-4">
        <h2 className="text-section font-semibold">What&rsquo;s opened up &mdash; all five kinds</h2>
        <p className="text-body text-ink-muted">
          Five ways a span becomes sellable and five different phone calls. The first row carries the two
          call marks &sect;8.6 asks for; the last has no client name, no number and no seed service, which
          is the row a walk-in leaves behind.
        </p>
        <ul className="flex flex-col gap-3">
          {FREED_SLOTS.map(({ slot, marks }) => (
            <FreedSlotRow key={slot.key} slot={slot} marks={marks} timezone={FIXTURE_ZONE} />
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-section font-semibold">Call marks &mdash; four outcomes, and the two-outcome sibling</h2>
        <p className="text-body text-ink-muted">
          The most-tapped control in the product (&sect;5.4.9). Every outcome stays live on a marked row, so a
          mis-press is corrected by pressing the right one; the undo appears only once something stands.
          Each button is 44px (&sect;4) and the pressed one is <code>aria-pressed</code> as well as inverted.
        </p>
        {/* The hidden payload is EMPTY on purpose, so a press on the workbench
            cannot write a mark: `recordOffer` refuses a blank subject and says
            so in its live region, which is also this page's only drawing of
            that message. The data says the row is not real — the same reason
            A-090's fixtures carry no `appointmentId`. */}
        {(['—', ...(Object.keys(OFFER_WORDS) as (keyof typeof OFFER_WORDS)[])] as const).map((outcome) => (
          <div key={outcome} className="flex flex-wrap items-center gap-3">
            <span className="w-28 shrink-0 text-caption text-ink-muted">
              {outcome === '—' ? 'nothing yet' : OFFER_WORDS[outcome].toLowerCase()}
            </span>
            <CallMarkButtons
              words={OFFER_WORDS}
              current={outcome === '—' ? undefined : outcome}
              hidden={{ subject: '', appointmentId: '', clientId: '' }}
              action={recordOffer}
              undoLabel="Not asked"
            />
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-28 shrink-0 text-caption text-ink-muted">call-down</span>
          <CallMarkButtons
            words={ATTEMPT_WORDS}
            current="left_message"
            hidden={{ appointmentId: '' }}
            action={recordAttempt}
            undoLabel="Not rung"
          />
        </div>
      </section>

      {DAYS.map(({ heading, note, model }) => (
        <section key={heading} className="flex flex-col gap-4">
          <h2 className="text-section font-semibold">{heading}</h2>
          <p className="text-body text-ink-muted">{note}</p>
          {/* `live={false}`: four grids each holding a 15-second refresh would
              reload the workbench under whoever is reading it. */}
          <DayGrid model={model} live={false} />
        </section>
      ))}
    </main>
  );
}

/**
 * The chip is absolutely positioned inside its column, so the gallery gives it
 * a box of exactly the height its duration buys at 1.5px/min — which is the
 * whole point of drawing it here. A 45-minute cut is 67 pixels and everything
 * §5.4.1 lists has to fit inside that.
 */
function ChipBox({ item }: { item: GridItem }) {
  return (
    <ol className="relative w-52" style={{ height: item.minutes * PX_PER_MINUTE }}>
      <AppointmentChip item={item} style={{ top: 0, height: item.minutes * PX_PER_MINUTE }} />
    </ol>
  );
}

/** §8.5's four compositions, in the order the brief lists them. */
const DAYS = [
  {
    heading: 'The day — four stylists',
    note: 'The tablet’s real shape: a shared gutter, four columns, the now-line, a gap that can be booked, a break, and a chip of most of the eight statuses.',
    model: FOUR_STYLISTS,
  },
  {
    heading: 'The day — one stylist',
    note: 'What the desk filters to on a quiet Monday, and what a stylist opens on her own phone.',
    model: ONE_STYLIST,
  },
  {
    heading: 'The day — a column forty minutes behind',
    note: 'The composition this component is riskiest in. Everyone who has not started yet carries BOTH times — the one on her confirmation and the one she is likely to be seen at. The visit already in the chair carries one, because a projected start on it would not be late, it would be wrong.',
    model: RUNNING_FORTY_LATE,
  },
  {
    heading: 'The day — a stylist off',
    note: 'Her column is still drawn. A missing column reads as a missing stylist rather than a day off — and time off over a working column is drawn as a band, because AVAIL-05 says a collision is surfaced for a human rather than hidden.',
    model: A_STYLIST_OFF,
  },
];
