# Self-Healing QA

Write a test in plain English. The system explores your app, records how to run it,
and replays it on every commit. When the UI changes, it repairs the test itself —
but only when the *test* is stale, never when the *app* is broken.

That distinction is the whole product. A self-healing tool that repairs everything
will eventually rewrite your suite until it passes, which is the opposite of what a
test suite is for.

---

## Setup

```bash
npm install
npx playwright install chromium
cp env.example .env      # add GEMINI_API_KEY
```

`.env` also holds test data. Plans reference credentials **by name**, never by value:

```
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.7-flash   # optional
TEST_EMAIL=user@example.com
TEST_PASSWORD=hunter2
```

A stored plan contains `valueRef: "TEST_PASSWORD"`. The password itself never enters
a file on disk, a prompt, or a log line.

---

## The three commands

```bash
# 1. Describe a test in English  (LLM)
npm run plan -- "Log in, view the product, and proceed to checkout" \
                http://localhost:3000 \
                checkout-flow

# 2. Record how to run it against the live app  (LLM + browser)
npm run baseline -- --plan checkout-flow

# 3. Run it  (no LLM, ~2s, exit code 0/1)
npm run run:test -- --plan checkout-flow

# ...and when the UI has genuinely changed:
npm run run:test -- --plan checkout-flow --heal
```

Steps 1 and 2 happen once. Step 3 is what you run on every commit.

| Flag | Applies to | Effect |
|---|---|---|
| `--plan <id>` | baseline, run:test | Which test to act on |
| `--headed` | baseline, run:test | Watch the browser drive |
| `--force` | baseline | Re-record over an existing baseline |
| `--heal` | run:test | Attempt repair on stale locators |
| `--threshold <n>` | run:test | Confidence gate for healing (default `0.85`) |

---

## How it works

Four stages, each producing an artifact the next one consumes.

```
English  ──►  Intent Plan  ──►  Baseline  ──►  Run Result  ──►  Heal Proposal
              (no selectors)    (executable)   (classified)     (verified or rejected)
```

### Stage 1 — English to intent

The model decomposes your sentence into atomic steps. It never sees your app at this
point, so it cannot emit selectors — targets are described the way a person would
describe them (`"password input field"`, `"checkout button"`).

Three layers of constraint, narrowest last:

1. **A response schema** constrains decoding, so an action outside the allowed set is
   not merely discouraged, it is unrepresentable. The vocabulary is fixed:
   `navigate` `click` `fill` `select` `check` `uncheck` `press` `hover` `assert` `waitFor`
2. **Schema validation** re-checks the reply on arrival. The wire is not trusted.
3. **Rule validation** enforces what a schema structurally cannot — `fill` needs a
   value but `click` must not have one, `assert` requires an expected outcome, a
   target that looks like a CSS selector is rejected.

Rule failures are fed back to the model with its own rejected output and the exact
error list, up to two retries.

**Every step must quote the instruction it came from.** Each step carries a
`sourcePhrase` that is checked as a literal substring of what you wrote. This is
mechanical, not a judgement call, and it exists because the model otherwise pads
plans from its own priors — asked for "log in, view the product, check out", it will
happily insert an add-to-cart step that you never requested and that your app may not
have. A step that cannot quote you does not get emitted.

**Stated values are captured, inferred ones are not.** An `assert` step also carries
`expectedValue`, set only when you named a literal value — and grounded against your
instruction the same way `sourcePhrase` is, so it cannot be invented:

| You wrote | `expectedValue` | The test then checks |
|---|---|---|
| "confirm the order total is shown" | `null` | that a total is displayed |
| "confirm the total is $49.00" | `"$49.00"` | that it reads exactly that |

Those are genuinely different tests, and the difference decides whether a later price
change is a pass or a failure. It has to come from your words rather than a guess.

### Stage 2 — Intent to baseline

The plan is walked against your **running application**. This is a real run: it logs
in, clicks, submits.

Resolution is per-step, because step N's page only exists once step N−1 has run.
Executing each step *is* how the system navigates to the next one, so a login page,
a product page and a checkout page are handled without anything special — by the time
the checkout step is resolved, the browser is already on the cart page.

For each step:

1. Extract every element on the current page, in three tiers: interactive controls,
   then headings / images / alerts / test-id-bearing containers, then **text-bearing
   leaves**. That last tier matters because most real assertions are about text — a
   total, a confirmation message, an error string — and none of that is interactive
   or a heading. Only leaves are collected: a wrapper's text is just its children's
   concatenated, so including ancestors would bury the real content in duplicates.

   Extraction does **not** cross iframe or shadow-DOM boundaries. Both are counted
   and reported at record time, so a baseline recorded against a page whose controls
   live inside one says so rather than quietly looking complete.
2. The model matches the step's semantic target to one element.
3. A locator is derived and **verified against the live page**: it must select that
   exact element and nothing else. A locator is never recorded on the strength of
   looking plausible.
4. The step is executed.
5. The outcome is **observed**, not guessed.

That last point matters. The intent plan says `"the checkout page is displayed"`. Only
the browser knows that means `/checkout`. The prose is kept as context, but what gets
asserted is what actually happened — and assertions **accumulate**, so a click that
navigated records the URL *and* an element that only exists on the destination.

Locators are ranked by how well they survive change:

| Priority | Strategy | Survives |
|---|---|---|
| 1 | `testId` | Redesigns, rewording, restyling |
| 2 | `role` + accessible name | Restyling, DOM restructuring |
| 3 | `label` / `placeholder` / `altText` | Restyling |
| 4 | `labelledBy` | **The element's own content changing** |
| 5 | `css` (`#id`, `[name=]`) | Rewording |
| 6 | `text` | Restyling only |

`labelledBy` is how a *value* gets an identity. A displayed total, status or name has
no test id and no accessible name, so the only thing left to match on is its own
content — and content-anchored identity means a data change breaks the locator, arrives
as `ELEMENT_NOT_FOUND`, and gets healed into the new value. A pricing regression would
be indistinguishable from a rename.

So extraction looks for the element that *labels* this one and locates by that instead:

```
xpath=//*[normalize-space(text())="Total"]/following-sibling::*[1]
```

One relationship covers the common markup for label/value pairs — `<dt>`/`<dd>`,
`<label>` and its field, `<th>`/`<td>` in a row, two sibling spans. All four are "the
next sibling of the labelling element". The anchor must be inert text: a control that
merely precedes an element labels nothing, and a heading names a section rather than
the field beside it.

Every strategy that verifies uniquely is kept as a fallback. A `text` locator is kept
even when it duplicates the accessible name, because the two fail under *different*
conditions: a rename breaks both, but a `<button>` refactored into an `<a>` breaks
only the role locator.

**A unique locator always outranks a positional one**, even from a weaker strategy.
`nth: 2` means "the third thing that looks like this" — it says nothing about the
element and silently retargets when the page reorders, and a wrong element that still
passes is worse than a clean break. When a step ends up positional anyway and the
tester never asked for a position ("the *first* product"), that is warned about at
record time.

Each recorded step holds four things:

```jsonc
{
  "intent": "Click the log in button to submit credentials",
  "locator": { "strategy": "role", "role": "button", "name": "Sign in" },
  "fallbackLocators": [ { "strategy": "text", "value": "Sign in" } ],
  "fingerprint": {                    // evidence for the healer, never a match condition
    "role": "button", "accessibleName": "Sign in",
    "context": "Sign in", "nearbyText": ["Email", "Password"]
  },
  "expectedOutcome": {
    "assertions": [                   // all must hold
      { "type": "urlContains", "value": "/home", "locator": null },
      { "type": "elementVisible", "value": null, "locator": { "...": "the destination heading" } }
    ],
    "intended": "user is logged in and home page is visible"
  }
}
```

### Stage 3 — Replay

The stored baseline is executed with **no model in the loop**. Nothing is sent to an
LLM, which is what makes it cheap enough to run on every commit. Exit code 0 or 1.

Each step:

1. **Check we are on the right page.** Every step records the URL it was recorded on.
   If the browser is somewhere else, the application is not in the state this step
   expects and no element lookup happens at all. URLs are compared by *shape*, so a
   dynamic segment is not a difference — `/orders/12345` and `/orders/67890` are the
   same page, `/home` and `/login` are not.
2. **Find the element** — primary locator, then each fallback, retrying while the page
   still looks busy (see below).
3. **Execute.**
4. **Verify the recorded outcome.**
5. **Verify the app is still healthy** — even though the outcome held.

If a fallback rescues the step, it passes but is **reported as drift** — the baseline
is one more change away from needing a repair.

The run **stops at the first failure**. Once a step fails, the app is no longer in the
state later steps assume, so continuing would produce failures that say nothing.

#### Is the element missing, or has the page not finished?

This is the most consequential question in the system, because getting it wrong means
handing a healer a page full of loading skeletons and asking which one is the checkout
button. It will find one.

So when an element is not found, the page is examined for evidence that it is still
working: same-origin requests still in flight, `aria-busy`, a visible progress
indicator, a `skeleton`/`shimmer`/`spinner` class, a DOM that is still mutating. While
any of that holds, the lookup retries (up to 10s). The moment the page looks settled,
it stops — however little time has passed.

The point is not patience, it is **attribution**:

- missing on a **settled** page → stale locator → healable
- missing on a **busy** page → `PAGE_NOT_READY` → a timeout, never healable

`networkidle` alone cannot answer this. It never settles on an app that polls or holds
a long-lived connection, it can be reached before the framework has rendered the
response, and a fetch fired from an effect starts *after* it. This is a heuristic and
will still be fooled by a bare skeleton with no ARIA and no recognisable class name —
but it moves the common case from silently wrong to correctly attributed.

### Stage 4 — Healing

Covered in full below.

---

## What it handles, and how

### The classification rule

Every failure is sorted by one question: **did we fail to find the element, or did we
fail to get the expected result?**

| Situation | Kind | Healable |
|---|---|---|
| Locator matched nothing, on a settled page | `ELEMENT_NOT_FOUND` | **yes** |
| Locator matched several, was unique when recorded | `LOCATOR_AMBIGUOUS` | **yes** |
| Found it, acted, outcome did not hold | `OUTCOME_NOT_MET` | no |
| Found it, could not act (disabled, overlay) | `ELEMENT_NOT_INTERACTABLE` | no |
| Missing, but the page is still working | `PAGE_NOT_READY` | no |
| Browser is not on the page the step was recorded on | `PAGE_DIVERGED` | no |
| Server returned 4xx or 5xx | `HTTP_ERROR` | no |
| Uncaught exception in the application | `PAGE_ERROR` | no |
| Browser page crashed | `PAGE_CRASH` | no |
| Request failed / app unreachable | `NETWORK_ERROR` | no |
| Navigation failed | `NAVIGATION_FAILED` | no |
| Anything else | `STEP_ERROR` | no |

Only the first two are ever offered to the healer. Note how many of the others are
also "the element wasn't there" — a 4xx, an expired session, a loading state and a
crashed page all present that way. Distinguishing them is most of the work, because
each one would otherwise look like a rename.

### Application health is checked first, always

A broken app *also* makes elements disappear. A 500 empties the page, so the element
is missing either way — and a naive classifier would call that `ELEMENT_NOT_FOUND` and
cheerfully heal a broken deploy into a green test.

So health is evaluated **before any locator reasoning**, in every path. If the server
returned an error, the page crashed, or a request failed, that is the verdict, and no
repair is considered.

Health is also checked **after a step succeeds**. An assertion can hold on a broken
page: `urlContains "/checkout"` is perfectly true of a 500 error page served at
`/checkout`. Reporting that as green is worse than a false red.

What counts as unhealthy, and why each is needed:

| Signal | Catches |
|---|---|
| Main-document status ≥ 400 | A dead route, an expired session surfaced as 401/403 |
| Same-origin sub-request 5xx | A failing API or form post in an app that navigates client-side, where there is no document response to inspect |
| `requestfailed` | The app or a dependency being unreachable |
| Page crash | The renderer dying |
| Uncaught page exception | A server error a framework renders on the client — a Next.js server component that throws arrives as an RSC payload with **status 200** and an exception in the browser, leaving no HTTP signal at all |

That last one is the least specific signal here, and it is included because without it
a whole class of server failure is invisible. Two well-known benign errors
(`ResizeObserver loop`, `Non-Error promise rejection`) are filtered; anything else
counts.

It is also the backstop rather than the primary defence. Because a step's outcome
requires the URL **and** an element that only exists on the working page, a 500 served
at the right path fails on the missing element regardless of whether any error event
fires. Error sniffing catches what slips past that.

### Cases handled

**A button is renamed.** `Checkout` becomes `Continue to Payment`. Locator and text
fallback both break → `ELEMENT_NOT_FOUND` → healable. With `--heal`, the model finds
the renamed control, it is executed, the original `urlContains "/checkout"` still
holds, and the baseline is updated.

**A button is restyled or refactored.** `<button>` becomes `<a class="btn">`. The role
locator breaks, the `text` fallback still matches. The step passes and is reported as
drift — no model call needed.

**Login stops working.** The sign-in button is found and clicked perfectly well; the
app simply does not authenticate. Only the `urlContains "/home"` assertion fails →
`OUTCOME_NOT_MET` → **never healed**. This falls out of the structure rather than
needing a heuristic that scans for the word "login".

**A business rule regresses.** Identical shape to the above. The element was fine, the
behaviour was not.

**The app returns 500.** Refused even if the URL assertion would have passed —
`HTTP_ERROR` from the status, or `PAGE_ERROR` when the framework renders the error
client-side and there is no status to read.

**A route is removed (404).** The page is gone, so every element is missing — but the
status code says why. `HTTP_ERROR`, not a stale locator.

**A slow API hasn't returned yet.** The element is genuinely absent when first looked
for. The page reports itself busy — requests in flight, a spinner, a mutating DOM — so
this becomes `PAGE_NOT_READY`, a timeout. The healer is never shown the skeletons.

**The session expired.** The app redirects to `/login`, so every element on the
recorded page is missing. Caught before any lookup, because the browser is not on the
URL the step was recorded against: `PAGE_DIVERGED`. Without that check this is one of
the most damaging false heals available — a login form has plausible input fields, and
a healer would happily rewrite the test to point at them.

**The app is down.** The run comes back as a classified run-level `NETWORK_ERROR` with
every step marked skipped — the honest reading, since nothing was tested.

**The data changes but the page doesn't.** A price goes from $49 to $59. What happens
depends entirely on what you asked for, and both answers are correct:

| Your test case | Result |
|---|---|
| "confirm the order total is shown" | **passes** — `labelledBy` still finds the amount beside "Total", and a total is still displayed |
| "confirm the total is $49.00" | **fails `OUTCOME_NOT_MET`** — never healed, because you asserted the value |

The important part is that neither reaches the healer. The value lives in the assertion
and the identity in the label, so a data change can no longer arrive as
`ELEMENT_NOT_FOUND` and be repaired into the new number.

**A feature is genuinely removed.** The healer is asked, finds nothing that serves the
original intent, and returns no candidate. The step fails. See below.

---

## The healing loop

Healing is **opt-in** (`--heal`). It costs model calls, it executes actions against
your app, and on success it rewrites your baseline file — none of which should happen
just because a test went red. Run plain in CI; heal deliberately when you know you
changed the UI, then review the diff.

### The sequence

```
step fails
    │
    ├── not healable ─────────────────────► stop. the app is broken.
    │
    └── healable
            │
            ▼
    model receives four inputs
        · the original intent
        · the previous element fingerprint
        · every element currently on the page
        · the expected outcome
            │
            ▼
    proposes up to 3 ranked candidates, or none
            │
            ├── none ──────────────────────► no_candidate. step fails.
            │
            ▼
    confidence gate (default 0.85)
            │
            ├── all below ─────────────────► below_threshold. nothing executed.
            │
            ▼
    locators derived for every admitted candidate,
    while the page is still untouched
            │
            ▼
    Playwright executes candidate #1
            │
            ▼
    the ORIGINAL recorded outcome is verified
            │
            ├── holds ─────────────────────► ACCEPTED
            │                                 · baseline locator replaced
            │                                 · fallbacks and fingerprint refreshed
            │                                 · previous locator kept in healHistory
            │                                 · run continues to the next step
            │
            └── does not hold ─────────────► rebuild state on a fresh page by
                                             replaying the preceding steps,
                                             then try candidate #2
                                              · all rejected → REJECTED, step fails
```

Locators for **all** candidates are derived before anything is clicked. Once a
candidate has been executed the page has moved on, so a later candidate could no
longer be resolved against the state that produced it.

### The principles it enforces

**The model proposes; the page decides.** A confidence score is an *admission filter*,
not proof. A high score only makes a candidate worth spending a real execution on.
Correctness is settled afterwards, by the application.

**The outcome verified is the recorded one, never a new one.** If the model supplied
both the candidate and the standard it is judged against, healing would be
self-certifying and the test would drift toward what the model believes instead of
what the app must do.

**Returning nothing is a correct answer.** The model is explicitly instructed that an
empty candidate list is right when a feature is gone, and told not to reach for the
nearest plausible control. A healer that always finds something eventually points your
suite at whatever happens to be on the page.

**A wrong candidate poisons state, so state is rebuilt.** Once a candidate has been
clicked, the app is somewhere the baseline never described. Trying a second candidate
from there would be testing nothing. Each retry replays the preceding steps on a
**fresh browser page** — fresh rather than reloaded, because a new page carries its
own storage and a half-completed login cannot leak into the replay.

**Continuing after a heal is safe.** A heal is only accepted once the step's original
outcome has held, which means the app really is in the state the next step expects.
Several steps may heal in one run, each verified independently.

**A heal that cannot run does not become the verdict.** If the model call fails — an
API quota, a network blip, a restore that could not rebuild state — the step keeps its
original classification and the heal failure is reported separately. An infrastructure
problem must never be relabelled as an application fault, and it must not erase the
diagnosis the step already had.

**Only stale-locator failures are ever offered.** The healer is not consulted for a
failed assertion, a 500, an expired session or a loading page. It is not asked to
judge those and then trusted to decline — it never sees them.

### Heal outcomes

| Status | Meaning | Baseline written? |
|---|---|---|
| `accepted` | Executed, original outcome held | **yes** |
| `rejected` | Every candidate that could be tried was executed, none satisfied the outcome | no |
| `below_threshold` | Best candidate scored under the gate; nothing executed | no |
| `no_candidate` | Model found nothing serving the original intent | no |
| `unlocatable` | Candidate proposed but no locator selects it uniquely | no |
| `execution_failed` | Acting on the candidate threw | no |

### What an accepted heal records

The previous locator and fingerprint are preserved on the step, so when a locator
later looks wrong, the reason it became that locator is in the same file:

```jsonc
"healHistory": [{
  "healedAt": "2026-08-30T13:16:32.881Z",
  "confidence": 0.95,
  "model": "gemini-3.6-flash",
  "reason": "The 'Checkout' link has been renamed to 'Continue to Payment' in the
             same card context and serves the exact same purpose.",
  "previousLocator": { "strategy": "role", "role": "link", "name": "Checkout" },
  "previousFingerprint": { "...": "as it was before the repair" }
}]
```

---

## Where things are stored

No database. Flat JSON, keyed by plan id.

```
data/
  plans/      <planId>.json    intent plan + the prompt and model that produced it
  baselines/  <planId>.json    locators, fingerprints, outcomes, heal history
  runs/       <runId>.json     every run, kept as history
```

The plan id is chosen by you, not derived from anything the model wrote — it is the
identity every later stage keys off, and a model that reworded a test name would
otherwise fork the record and orphan its baseline.

---

## Confidence thresholds

| Gate | Default | Applies |
|---|---|---|
| Baseline resolution | `0.70` | Matching a step to an element during recording |
| Healing | `0.85` | Admitting a candidate for execution |

Recording is more permissive because it runs against a known-good app under review.
Healing is stricter because it rewrites a test that already passed.

---

## Current limits

### Known correctness gaps

**Label/value pairing only works when the markup expresses it.** `labelledBy` handles
the label being the previous element sibling, which covers `<dt>`/`<dd>`, `<label>` and
its field, `<th>`/`<td>` in a row, and sibling spans. It does **not** cover a label and
value several wrappers apart, a CSS-grid layout where DOM order does not match visual
pairing, a two-dimensional table cell needing both a row and a column anchor, or a
visually-hidden label. When no anchor can be derived, the locator falls back to the
element's own text — and a data change then presents as a stale locator, healable, with
the value quietly rewritten.

A `data-testid` on the target removes the problem entirely, and **the system produces
markedly better baselines against apps that have test ids.**

**Fingerprints carry unweighted volatile text.** `nearbyText` records prices, dates and
counts as evidence for the healer, and they drift on every content update. It still
matches on role and purpose first, so this degrades the evidence rather than breaking
anything.

**Iframes and shadow DOM are not traversed.** Payment fields, embedded widgets and most
web-component design systems are invisible. Detected and warned about, not solved.
Virtualised lists (only visible rows exist) and `<canvas>` UIs are likewise opaque.
Note that framework dev tooling injects shadow roots of its own, so the count is not
all application code.

**No assertion for the absence of something.** "No error banner appeared" cannot be
recorded, so a step that succeeds while an inline validation error shows up still
passes. `role="alert"` and `aria-live` are standardised enough to make this tractable.

### Scope limits

- **One test per command.** No suite runner, no aggregate report, no parallelism.
- **Every run starts cold** from the start URL. No session reuse, so a long flow
  repeats its login each time.
- **No screenshots or traces** on failure — you get a classified message, not a picture.
- **A rejected heal ends the run**, so later stale steps in the same run go unreported.
- **Nothing caps how many steps may heal in one run.** Each is verified independently,
  but "the entire test changed" deserves a human's attention rather than a file that
  quietly updates.
