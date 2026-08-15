# PRD Stub: Project #2 — "Membership" — Subscriptions & Recurring Revenue for a Service Business

**Status:** Skeleton v0.1 — 2026-08-14. This is the "Project #2 (subscriptions)" referenced in Bookable's Non-Goals. It is a *stub*: enough to keep the learning-portfolio map honest, not enough to build from. Expand it through the same three-review pass Bookable got before starting.

## Why this project is trickier to scope than it looks

The rental platform **already** exercises Stripe Billing subscriptions end to end (its D-11: Customer/Price/Subscription, webhooks → append-only projection, collection-method switching, dunning, NSF fees, proration pushed as invoice items). A "subscriptions project" that rebuilds that teaches nothing new. The learning surface left over is the *self-serve subscription lifecycle* — the part rental deliberately staff-mediates:

**Sample business:** a membership-based massage/wellness studio ("Kneaded") — monthly memberships that bank credits, tiered plans, add-ons, gift cards. Pairs naturally with Bookable (a member books with credits), but must stand alone.

## Learning objectives (the delta over rental)

1. **Self-serve plan changes with proration in both directions** — upgrade mid-cycle, downgrade at period end, the preview-before-commit UX, and the "what Stripe does vs what we promise" reconciliation.
2. **Entitlements as a projection** — credits banked per period, rollover caps, consumption, expiry; the credit ledger is append-only and derived from subscription events, never edited.
3. **Trials, pauses, and win-back state machines** — trialing → active → paused → past_due → cancelled, with the customer (not staff) driving transitions.
4. **Coupons/promotions and their abuse edges** — stacking rules, first-month-only, referral credits.
5. **Revenue recognition basics** — deferred revenue for banked credits; a report an accountant would not laugh at.

## Non-Goals (draft)

- Rebuilding invoice/payment projection machinery — port the rental patterns (D-11/D-24/D-32 there) as a given, don't re-derive them.
- Appointment scheduling — that's Bookable; integration is a Phase 3 flag in *both* repos.
- Physical access control, POS hardware, multi-location.

## Open questions to answer before drafting v1

- OQ-a: Credits or unlimited-with-fair-use? (Determines whether the entitlement ledger exists at all — the main learning artifact.)
- OQ-b: Does pause stop credit accrual, expiry, both? Every studio answers this differently and it drives the whole state machine.
- OQ-c: Stripe test-mode account availability (rental's D-26 gate applies: no driver until a key exists; simulator-first per its D-23).
- OQ-d: Where does this rank against finishing Bookable Phase 3? Recommendation: **do not start until Bookable's Milestone 4 checkpoint has been walked** — two half-done scheduling/billing projects teach less than one finished one each.

## Skeleton milestones

M1 Foundation (scaffold, entitlement ledger schema + append-only trigger, event outbox — half a day each given two prior builds) → M2 Subscribe & entitle (plans, checkout, credit accrual projection, consumption API) → M3 The lifecycle (plan changes + proration preview, pause/resume, trials, dunning surface) → M4 Money truths (deferred-revenue report, coupon engine, reconciliation sweep).
