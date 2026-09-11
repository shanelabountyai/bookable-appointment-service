# Demo checkpoint 10 — the walk on the book Phase 12 taught to tell people apart

**Walked 2026-09-11, at the Phase 12 close. This is the first walk since A-106
gave the desk an answer to "when can you fit me in?", A-108 made the seed
dispatch its own outbox, A-111 took the product's assumptions about gender out
of its voice, and A-113 put a double-booked hour and a client list of different
people on the demo install.**
**Result: three defects. The headline is that the book now holds people who
are different from each other, and the product cannot tell when two of them are
the same person.**

Checkpoint 9 found a control hidden from the column it had just taught to keep
drawing. This walk followed NEXT.md's instruction, *"read the rendered text
against them. That is the point."*, and did it in the one place checkpoint 9
could not: **as the client**. A seeded client booking online with her own phone
number is the first thing a real salon's regular does, and in ten phases no walk
had done it. It took two attempts to find the headline.

The walk ran against a production build on a **freshly created database,
`bookable_cp10`**. It was made for this walk, so `bookable_test` stayed free for
the operator review, which was resetting it at the same time. `bookable_dev` was
not touched. The scripts are deleted; what they found lives on as the
transcripts below.

---

## The book it was walked on

`seedSetup` then `seedDensity` on an empty, freshly migrated schema:

```
[seed] 4 providers, 8 services, 686 appointments, 13 clients (spring-forward 10, fall-back 3;
       19 days around today, 116 left open; 3 on the waitlist, 2 call marks, 2 call-down
       attempts, 5 lapsed; 686 messages sent, 1 double-booked by override)

4 providers   8 services   13 clients   4 chairs
691 appointment rows   booked 464  completed 163  checked_in 58
                       no_show 3   cancelled_late 2  cancelled 1
3 on the waitlist   1 time off   11 date overrides   682 chair holds   713 worked blocks
686 outbox rows — 683 confirmations + 3 cancellations — every one `sent`, `deliveredBy = log`
Business.remindersLastRunAt: NULL

book spans 2025-09-12 … 2026-11-01 over 29 days with appointments on them
future book: Fri 11 … Sat 19 September, SEVEN working days (32 / 43 / 20 / 41 / 28 / 35 / 29)
             plus the three fall-back rows on 1 November
```

**Today is Friday 11 September and the salon is open.** The seed ran at 08:44
CDT and the walk ran from 08:50.

**The seed log says 686 appointments and the table holds 691.** The five
lapsed-client visits are written by a separate function, and
`appointmentsCreated` does not count them. Those five, plus the three
`seed-noshow-*` history rows, are the eight appointments carrying no chair hold
and no confirmation. That is correct for past visits written by hand, and it is
why 683 confirmations stand against 691 rows. It is worth one line because A-095
already fixed this seed's total under-reporting itself once.

**What of Phase 12 can be walked on the demo install:**

| item | on the demo book? |
|---|---|
| A-106 the desk's day list | **yes**, on the move panel and on the booking panel's refusals |
| A-107 off-roster controls | yes, by flipping one boolean (done below, then reverted) |
| A-108 never-tried bucket, watermark | the screen and watermark yes; **the missed-reminder list no** (see Scene 3) |
| A-109 the opened-slot floor | not exercisable: `/staff/opened` holds one 25-minute row, and nothing decays without time passing |
| A-110 waitlist door, open-days checkboxes | yes |
| A-111 the voice | yes |
| A-112 undo a cancellation | **yes**: the seed cancels Tom Byrne's 09:00 today, inside the window |
| A-113 the override pair | **yes**: Sam Okafor and Alice Hall with Dana, 09:00 Saturday 12 September |

---

## The crawl

Thirty-seven routes at 1024×768, **each in both colour schemes**, through
A-096's freeze. The staff routes include the override day, Dana's list and
print sheet, both override appointments, three client records (the long name,
the accented name, one of the two Dunns), and three client searches. The public
routes are `/`, `/services`, `/stylists`, `/visit` and `/book`.

```
74 route×scheme pairs:  74 × HTTP 200
                        0 axe violations, in either scheme, on any of them
                        0 console errors, 0 page errors
                        0 bounced to /staff/login — every row printed the URL it landed on, its <h1>
                          and its body length
incomplete (not violations):  /staff/day 2 · /staff/day?day=2026-09-12 2 · Dana's list 1 · /staff/design 4
```

**A-111 holds on the rendered surface, and this is the measurement that says
so.** The rendered text of all thirty-seven routes, grepped for
`\b(she|her|hers|herself|he|him|his|himself)\b`, returns **0 matches**. That
includes `/staff/unfinished` at 11,066 characters, the screen where checkpoint 9
counted 248. A-111's own test parses source. This parses what a browser drew,
from the other end, and the two agree.

The crawl also measured **every element whose own text overflows its box**
(`scrollWidth > clientWidth` under `overflow: hidden` or `text-overflow:
ellipsis`). That is A-113's rule, *an assertion that something is visible passes
on an ellipsis*, run over every screen rather than one chip. It found the second
of the smaller things below.

---

## Scene 1 — Alice Hall is blocked from booking online, unless she writes her phone number the way people write phone numbers

*Alice Hall is the seeded client with three no-shows. Every screen that shows
her says* **"⚑ 3 no-shows in the last 12 months. Cannot book online — the desk
can."** *That is CLIENT-04's lever, enforced at `book.ts:189` for
`audience: 'public'`.*

Two attempts through the real `/book` flow: Cut, Tess, the first day, the first
time.

```
name "Alice Hall"   phone "+1 512 555 0101"
  → Cut with Tess · Saturday 12 September at 16:00 · 45 min · $55.00
    "We can’t book this one online. Please call the salon and we’ll get you in."

name "Alice Hall"   phone "(512) 555-0101"
  → "Your appointment is confirmed
     Cut with Tess, Saturday 12 September at 16:00.
     We've sent you a confirmation with a link you can use to change or cancel it."
```

```sql
select id, name, phone, appts, no_shows from "Client" where name = 'Alice Hall';
 cmtx0d3c0005wrd24wjmv5onj | Alice Hall | +15125550101 | 84 | 3
 cmtx0tp0q0001rdvnpy7cvmm6 | Alice Hall | 5125550101   |  1 | 0     ← created 08:57:47, one minute ago
```

**The block held when she typed the number one way and let her through when she
typed it the other.** She did not type her name differently, and the desk had
nothing to do with it. The desk now has two of her:

```
/staff/clients?q=0101
    Alice Hall   +15125550101   ⚑ 3 no-shows in the last 12 months. Cannot book online — the desk can.
    Alice Hall   5125550101

/staff/day?day=2026-09-12, Tess's column
    16:00  Alice Hall
           Cut · 5125550101          ← no flag
           Check in
```

### Why

`normalizePhone` (`packages/core/clients/phone.ts:22-26`) strips everything
except digits and **keeps a leading `+`**. One number therefore has three
identities:

```
"+1 512 555 0101"  → "+15125550101"
"(512) 555-0101"   → "5125550101"
"1 512 555 0101"   → "15125550101"
```

Its own header (`phone.ts:16-20`) says `+15125550101` and `15125550101` *"are
the same number written two ways"*, then explains why it keeps them apart. The
public booking reuses a client only on an **exact** `(phone, name)` match
(`apps/web/lib/booking/public-actions.ts:396-399`) and otherwise calls
`prisma.client.create`.

`confirmAppointment`'s lookup, run verbatim against the walk database:

```
typed name            typed phone          stored as        matches
Rae Núñez             +1 512 555 0104      +15125550104     Rae Núñez
RAE NÚÑEZ             +15125550104         +15125550104     Rae Núñez
Rae Núñez             (512) 555-0104       5125550104       NONE → creates a new client
Rae Núñez             512-555-0104         5125550104       NONE → creates a new client
Rae Núñez             1 512 555 0104       15125550104      NONE → creates a new client
Rae Nunez             +1 512 555 0104      +15125550104     NONE → creates a new client
Rae Núñez (NFD)       +15125550104         +15125550104     NONE → creates a new client
```

**The name has the same fault, and A-113's new names are what made it
visible.** `mode: 'insensitive'` folds case, not accents, and not Unicode
normalization form. "Rae Nunez" is a stranger. So is "Núñez" typed as a
decomposed `u` + combining acute, which some keyboards and most copy-pastes
produce and which renders pixel-identically. The desk's own search has the same
blind spot:

```
/staff/clients?q=nunez    →  Nobody matches “nunez”.
/staff/clients?q=Núñez    →  Rae Núñez  +15125550104
desk search "0104" / "512 555 0104" / "+1 512 555 0104"  →  Rae Núñez, all three
```

**The desk's phone search is looser than the website's write.** It matches on
digits contained anywhere (`packages/db/clients/clients.ts:77`), so it finds
Rae under every format. The website creates a new Rae under every format but
one. The desk sees one client where the website is making three. This is this
repo's most-found defect class, pointed at identity instead of time: two
answers to one question, *"is this the same person?"*, and the looser answer is
on the screen the humans read.

### The trade that was decided, and the one that was not

`public-actions.ts:386-395` states plainly that *"a client blocked under
CLIENT-04 can therefore get past the block by typing her name differently, and
that is the deliberate trade"*. Keying on the phone alone would merge a
household, which is the harm D-17 exists to prevent. That trade is about the
**name**, and it was reasoned in writing. **Nobody decided the phone format.**
A regular who knows the rule could spell her name differently. Alice did
nothing of the kind: she wrote her own number the way she writes it on every
form she has ever filled in.

**It is not a seed artefact, and the seed makes it universal.** All thirteen
seeded clients are stored in `+1` form:

```sql
select left(phone,1) = '+' as plus, count(*) from "Client" group by 1;   →  t | 13
```

That is the one form a US client almost never types for her own number. So on
the demo install, every returning client who books online the ordinary way
becomes a second client, with no notes, no history, no flag and a clean
reliability record. In production it cuts both ways. The desk types what the
client says on the phone, the website takes what her phone's autofill
(`autoComplete="tel"`, `booking-flow.tsx:451`) or her thumbs produce, and the
two have to agree **character for character after normalization**, for a
client the product has otherwise been built to recognise by phone (CLIENT-01).

### Why nothing catches it

`booking.spec.ts:71` types `(512) 555-0101` and `:87` asserts the stored phone
is `5125550101`. **The same literal is written on both sides of the equality**,
which proves the normalizer is deterministic, not that it recognises anyone.
Every fixture that exercises client matching creates the client and then books
as her with the string it just used. A book of ASCII names and one phone format
cannot produce the case. A book with `Rae Núñez` in it can, which is exactly the
argument A-113 won for widening the names.

**The harm, in the operator's terms:** CLIENT-04 is the product's only lever on
a serial no-show, and it silently stops working for anyone who writes a phone
number with brackets. The split record also loses the pinned client note
(CLIENT-03, which is a safety surface) on every appointment made under the
duplicate. A-015's merge exists, but nothing tells the desk there is anything
to merge.

**This needs a decision before it is built.** `phone.ts`'s header documents the
choice to keep `+`, and changing what counts as the same client is not a
refactor. The fix has three parts: a canonical form (canonicalising is not
validating, so the header's "deliberately NOT E.164 validation" can stand), a
migration that rewrites stored phones into it, and a folded name comparison
(NFC plus accent folding) used by **both** the write and the desk search.

---

## Scene 2 — "When can Dana fit me in?" gets an answer on the day she is off, and none on the day she is full

*The measurement that scoped A-106 at the Phase 11 close was, verbatim,
"Dana's colour book is dead for eight consecutive days". That book was dead
because it was FULL, not because she was away.*

`/staff/book`, Dana, Colour, client Rae Núñez. The day is changed **on the
panel's own date box**, so the client-side lookup actually runs. Loading a URL
with `?day=` does not run it, and a walk that only loads URLs would have
reported the day list missing everywhere.

```
Saturday 12 September      WHAT TIME?
                           09:00 — they already have a client then
                           09:15 — they already have a client then
                           …                                              32 times, every one refused
                           16:45 — it would run past closing
                           Another time?  [     ] Use it
                           (no day list · no "Put them on the list for this")

Wednesday 16 September     the same: 32 refused times, nothing else

Sunday 13 September        They are not working that day. Type a time below if you mean to book them anyway.
  (the salon is shut)      The next days with room:
                             Tuesday 22 September · Wednesday 23 September · Thursday 24 September · …
                           Put them on the list for this
```

**The answer, "Tuesday the 22nd", is on the screen only when the desk asks
about a day the salon is closed.** A desk asking about Saturday, then Tuesday,
then Wednesday, then Thursday, then Friday gets five screens of thirty-two
refusals each, which is the Phase 11 dead end with better reasons attached.

**The move panel, same stylist, same full Saturday, answers correctly.** On
Dev Iyer's appointment with Dana:

```
Move to which day?  2026-09-12
What time?          Nothing free that day for this visit.
                    The next days with room:
                      Tuesday 15 September · Thursday 17 September · Friday 18 September · …
```

Two surfaces, one question, and they disagree on the busiest shape a book has.

### Why

`booking-panel.tsx:284`:

```ts
await answerWhenNot(offered.length === 0, provider.id);
```

`offered` is A-042's list, and A-042 made that list carry **refused times as
well as bookable ones**, so the desk can tap a refused chip and reach BOOK-05's
override. A day with every time refused is therefore never empty, and the
comment above the line (`:280-283`) says so on purpose:

> *"She is not working that day" is the refusal this answers, and the engine
> says that by returning NO CANDIDATES AT ALL — not by refusing them. A day
> where every time is refused still has A-042's list, an override behind each
> chip, and nothing to be redirected away from.*

That is true about the override and not about the phone call. The override is
how the desk **double-books**, and D-8 made it a deliberate, typed-reason act.
"Nothing to be redirected away from" is a list of thirty-two ways to overbook
a client who asked when Dana is free. The move panel asks
`found.length === 0` of `staffMoveOptions`, which returns bookable slots only
(`move-panel.tsx:77`), and that is the entire difference between the two
screens.

**A-110's waitlist door is inside the same branch** (`booking-panel.tsx:541-547`).
So the sentence WAIT-01 exists for, *"I can't give you anything for three
weeks"*, which a desk says about a full book, has no door on the day it is
said. The door appears on shut days, when nobody is waitlisting anything.

### Why nothing caught it

**The backlog row prescribed the fixture, and the fixture it prescribed is the
branch that works.** Row 108 reads: *"The fixture is the item: a MULTI-DAY
absence with the stylist genuinely gone for a week."* A-106 did exactly that.
`desk-day-search.test.ts` puts Dana away for nine days on one `TimeOff` row and
mutation-checks every assertion. An absence is the one shape that returns no
candidates at all. The measurement that motivated the row was a full book, and
the fixture written for it was an empty one. Both are "Dana cannot take her",
and only one of them reaches the code.

**Measured while here, because A-106 recorded "nothing measures it yet":** the
fortnight lookup settles in **~0.3 s** on the demo book, for both the named
and the "anyone" arm. Its cost is not the problem.

---

## Scene 3 — the screen says "Everything has gone out"; every appointment says "queued"

```
/staff/messages
    Messages that did not go out
    …
    Everything has gone out. Nothing is waiting and nothing has been given up on.
    The reminder job has never run.

/staff/appointments/{Sam Okafor, 13 June, cancelled late}
    WAS THE CLIENT TOLD?
    Booking confirmation   sam@example.test · email   queued
    Cancellation           sam@example.test · email   queued

/staff/appointments/{Tom Byrne, today 09:00, cancelled}
    WAS THE CLIENT TOLD?
    Booking confirmation   tom@example.test · email   queued
    …
```

```sql
select "deliveredBy", status, count(*) from "NotificationOutbox" group by 1,2;   →  log | sent | 686
```

**The same 686 rows, two screens, opposite answers.** The appointment page is
the honest one, and it is honest on purpose. `deliveryWord`
(`apps/web/lib/appointments/event-language.ts:239-245`) turns
`sent && !reallyDelivered(deliveredBy)` into "queued". The reason is written in
`packages/db/notifications/provider.ts:14-32`: *"'Told: Cancellation — sent' is
read at the front desk as 'no need to call her', and with the console adapter
it means a line on the server log."* A-044 and A-048 spent two items making
that one word true.

`/staff/messages` never asks. `allClear` (`messages/page.tsx:55`) is
`stuck.length === 0 && missed.length === 0`, and `:70` prints the healthy
sentence. **`notificationAdapter` is `LoggingChannelAdapter` in every build**
(`provider.ts:12`; A-053 stays blocked), so on every install that exists today,
every outbox row is `log`, every appointment says "queued", and the one screen
whose heading is *"Messages that did not go out"* says everything has gone out.

**A-108 is what made this visible, and it did the right thing.** Before it, the
demo outbox was 713 rows `pending` and never attempted, and the screen was
blind. A-108 dispatched them in the seed, as the operator asked, and the screen
went from blind to contradicting. The Phase 11 operator review called the old
state *"a screen that reports delivery it never observed"*. The new sentence
still does exactly that, just over rows that are now marked `sent`.

**Its second half is the A-113 shape, one feature over.** A-108's
missed-reminder list cannot be shown on the demo install:

```
booked appointments starting in the next 24 hours:                        31
  … of which created ≥ 24 h before they start (predicate 3, so "missable"):  0
Business.remindersLastRunAt:                                             NULL
```

The seed writes the whole book at 08:44 today, so nothing in the next day was
ever old enough to have been swept, and the list is empty by construction.
*"The reminder job has never run"* is the only trace on screen of the feature
A-108 built. It is a backlog row, not a defect.

---

## What was checked and is clean

Recorded so the next checkpoint does not spend the pass.

- **A-113's override holds on the book it seeded.** Dana's column is
  `grid-column: span 2` (424 px). The two 09:00 chips share a `top` (y = 481),
  sit side by side (x 245 and 452, each 205 px) and **both names fit**
  (`scrollWidth ≤ clientWidth`: 50 ≤ 50, 64 ≤ 64). The print sheet has both
  rows: *"At the same time as Sam Okafor."* with the typed reason *"Only free
  hour before the wedding — agreed to double up"*, and *"At the same time as
  Alice Hall."*
- **A-107 holds.** With Tess flipped to `active = false` (reverted
  afterwards), her column reads *"off the roster — still booked"* and keeps
  **Behind by** and **Push the column**, on today and on Saturday.
- **A-112 holds, and the window is right.** Tom Byrne's cancellation from this
  morning offers *"Put it back on the book"*, a reason box and *"Text them to
  say it's back on — They were already sent a cancellation. Leave this alone if
  you're ringing them."* Sam Okafor's late cancel from June says *"Nothing more
  to do with this one — cancelled late is where it ends."*
- **A-110's second half holds.** The waitlist's "Which days" checkboxes are
  Tuesday to Saturday, the days this salon opens.
- **A-106's move panel answers a full day** (Scene 2 above), and the lookup
  settles in ~0.3 s.
- **A-111**: 0 gendered pronouns in the rendered text of 37 routes (The crawl).
- **The desk's phone search** finds a client under every format tried: last
  four digits, local, `+1`.
- **`/staff/conflicts`** on a day with no strandings names the day it was asked
  about: *"Nothing stranded on Friday 11 September."*

## Three smaller things, worth a line each

- **The waitlist prints its stored tags.** *"Colour · Any provider · Wednesday
  2 September–Sunday 11 October · **saturday, morning**"*.
  `waitlist/page.tsx:200` is `entry.dayParts.join(', ')`, which puts lowercase
  enum values on a list the desk reads down the phone. A-110 rebuilt the
  checkboxes that write these values and did not touch the line that reads them.
- **The reliability flag is cut in half on every ordinary chip.**
  `appointment-chip.tsx:126` renders the flag `block truncate`, and in a normal
  column Alice's flag measures **386 px of text in a 178–185 px box**. So
  *"Cannot book online — the desk can."* is never visible on the day grid, on
  any chip. The accessible name carries the whole sentence, which is why axe
  and `getByRole` pass. *"1 late cancel in the last 12 months"* loses its last
  word (192 in 178). A-113's rule, one line lower on the same chip.
- **The seed's long name is kept off the grid, and the reason given is wrong
  in the direction that hides it.** `density-seed.ts:807-809` puts *Jordan
  Fairweather-Okonkwo* in the lapsed pool, with one past visit, because *"a
  half-width chip beside an override does not"* have room. For this walk a
  live client in the walk database was renamed to it, then renamed back. The
  name is cut in the override lane (157 px in 151) **and on ordinary chips in
  an ordinary column** (157 in 144–145), on both days measured. Only the
  full-width lane chip fits it. More generally, the five new names hold one
  appointment each, all in the past; eight clients hold the other 686. The
  widened list is on the lapsed report and nowhere the desk works a day.

---

## The rule this checkpoint leaves behind

> **A FIXTURE THAT MAKES A CASE EXIST USUALLY MAKES THE VERSION OF IT THAT
> WORKS.** All three findings sat behind a fixture chosen in good faith to
> exercise exactly the thing that turned out to be broken. A-106's row measured
> a **full** book and prescribed an **absence**, and an absence is the one
> shape the code branches on. A-113 widened the names and placed the long one
> **where it fits**, with a comment explaining why it would not fit anywhere
> else. `booking.spec.ts` checks that a client is recognised by **typing her
> number once and asserting it back**. None of them is lazy. Each is the
> natural way to write the case down, and each chose the shape of the case the
> author was already picturing. **When a row carries a measurement, the
> fixture must reproduce the shape of the measurement, not the sentence written
> about it.** When a test asserts an equality between two things two different
> people type, it needs two different people typing.

Its companion, from Scene 1: **identity is an equality, and every equality in
this product has a looser reader beside it.** The desk's search matches digits
contained anywhere, and the website's write needs exact characters. The desk
therefore sees one Rae Núñez while the website quietly makes three, and the
reader that humans look at is the one that cannot see the split. That is the
offered-versus-accepted class this repo has caught many times on the time
axis, turned onto the axis of who someone is.
