# FoodSim — notes for Claude

Static HTML simulations, no build step. Served from GitHub Pages and from Vercel.

## Deploying — read this before saying anything is live

The Vercel project is **food-sim** (`food-sim-six.vercel.app`). The pages that
matter are `jev-lab.html` and `foodsim_data_sorting.html`.

**Vercel's Git integration for this repo stopped producing builds partway
through 2026-09-20 and did not recover.** After that point neither API merges
nor direct pushes to `main` deployed anything, with no error surfaced anywhere.

An earlier note here blamed API merges specifically. That was wrong - it was
inferred from deployments that had all happened *before* the integration broke,
and a direct push failed the same way an hour later. Do not repeat that
inference from a handful of rows.

`.github/workflows/deploy.yml` now calls a Vercel **Deploy Hook** on every push
to `main`, which does not depend on the Git integration. It needs a
`VERCEL_DEPLOY_HOOK` repository secret; without it the workflow skips.

Landing work:

```bash
git checkout main && git pull
git merge --no-ff claude/<branch>
git push origin main
```

Then confirm a build actually exists for that commit - the Actions run is the
first place to look, Vercel's Deployments list the second.

Two more traps, both already hit:

- **Promoting a preview to production pins production to that commit.** Later
  merges to `main` then never appear, however many times the page is reloaded.
  Check Vercel → the project → Settings → Git → Production Branch is `main`.
- **Environment variables only take effect on a rebuild.** Setting
  `TYPESAFE_API_KEY` does nothing to an already-built deployment; redeploy after
  changing it.

Never claim a change is visible to the user until a deployment for that commit
exists. Saying "merged and pushed" is not the same thing, and the user cannot
tell the difference from the page.

## Reaching the outside world

The sandbox has **no network access to `api.typesafe.ai`, `docs.typesafe.ai`,
`*.vercel.app` or `nomarcus.github.io`**. That means:

- The live site cannot be checked from here. Ask the user, or ask for a
  screenshot. Do not guess at whether a deploy landed.
- Real API responses cannot be observed. Everything is tested against a mock,
  and that limitation belongs in any claim about results.
- API contracts must come from the published SDK (`npm pack @typesafe-ai/sdk`)
  rather than memory — the endpoint, `Bearer` auth and request shape were all
  read out of its bundle.

## Testing the pages

Playwright and Chromium are installed. Drive the real page and intercept the
API rather than testing functions in isolation — most of the bugs in this repo
were only visible in the running page:

```bash
node /opt/node22/lib/node_modules/http-server/bin/http-server . -p 8099 --silent &
# then a Playwright script against http://127.0.0.1:8099/<page>
```

**Screenshot the result and look at it.** Counters have repeatedly read fine
while the page was unusable: a fleet of couriers collapsed into three stacked
columns, and a queue of held couriers covered the one number the demo depends
on. Neither showed up in any metric.

When behaviour stalls, instrument state rather than watching — printing phase
counts found a package-claim leak in seconds that was invisible on screen.

## What is the model and what is not

`jev-lab.html` benchmarks TypeSafe's System One model (Jev). Be exact about the
boundary, because the user presents this to an audience:

- **Jev decides** the category (`choice`), urgency (`score`) and whether a
  ticket needs a human (`noul`) — three independent judgments per ticket,
  answered in parallel inside one request.
- **Ordinary local code** does courier movement, spacing and routing. It does
  not learn. Never describe it as the model deciding anything.
- Only the **category** has a hand-written answer key (`gold` in
  `typesafe-tickets.js`), so only the category is scored. Urgency and escalation
  are displayed, never graded — there is no truth for them to be measured
  against.
- The gold labels must never reach a classifier or the API. That separation is
  the whole basis of the comparison.
- The **template desk** (500 Inspire workflows) is synthetic, generated from a
  fixed seed in `inspire-templates.js`. Jev judges relevance per template
  (`noul`), then intent, affected area, fit and size for the top three. Only
  relevance has a key, so only "found" is scored. The answer card is assembled
  by code from those judgments - never describe Jev as writing the reply or
  reading WFD files, and the time shown is a size band, not a measurement.
- **Beach volleyball** in jev-lab is a separate, simpler game from
  `Vollyball.html` (which is never edited for it). Jev makes one `choice` per
  touch - set to a teammate, or attack short/mid/deep/lob. Running, ball
  flight, the net, the rules and the "Rules" playbook are code. Physics runs in
  1/240 s substeps: at 4x a whole frame let the ball skip past hand height, and
  the serving side won every point. Check any physics change with rules vs
  rules at 1x and 4x - touches per point must match - before trusting a score.

## Colour

Charts use the validated categorical palette (slots 1–3), not the simulation's
red/green/cyan — red vs green is the classic colour-vision confusion pair and it
sat on the two categories most often mixed up. Validate before changing:

```bash
node <dataviz-skill>/scripts/validate_palette.js "#3987e5,#d95926,#199e70" \
  --mode dark --surface "#0f1430" --pairs all
```

## Vollyball.html (NEAT volleyball)

- Physics is 3D (x towards the net, y height, z across the court). The 2D view
  is a side-on look at the same court; `vollyball-3d.js` (three.js vendored in
  `assets/vendor/three`) draws the same simulation in 3D.
- Every body part is a capsule and both views draw it at exactly its collision
  radius. Audit any physics change by stepping a `Match` headless and checking
  that no ball overlaps any capsule after a step, and that the gap at a touch
  is ~0.25 px.
- The brain is shared by all blue players and mirrored (x and z). It makes the
  volleyball decisions only (spike or not, aim, side, power, pass, flip); running
  to the ball or back to a home spot is code, and so is the timing of a spike
  jump. Say so when describing it.
- Training is against a coded **coach** (orange) with levels 1-8. Fitness is
  points won/lost; rallies cut off at 30 s count for neither side. The champion
  is re-checked on 24 fresh rallies each generation and the coach levels up at
  70% of at least 12 decided rallies. Measure learning by playing the same serves
  with generation-1 brains and the champion (start brains ~50% vs level 1).
- Volleyball rules are code: serve from behind the end line, max three touches,
  no double contact, antennas, out on lines/walls/ceiling, rally scoring, sets
  to 25 by 2, side-out rotation. The brain decides pass-or-attack per touch;
  the pass trajectory is computed by code - say so when describing it.
  Players read a new ball flight 0.3 s after each touch (reaction time);
  without it nobody could ever score in competition mode.
- Turbo training gets at least ~35% of each frame, however slow the drawing.
  Software-GL headless Chromium renders 3D at ~6 fps, so test learning in 2D.
