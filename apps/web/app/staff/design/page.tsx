import { requireStaff } from '@/lib/auth/session';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { Tab, Tabs } from '@/components/ui/tabs';

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
    </main>
  );
}
