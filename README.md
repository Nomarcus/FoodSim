# Foodsim

Foodsim is a simple front-end HTML project — a browser-based game or interactive demo built with plain HTML (and optionally CSS/JS included in the repo). This repository currently contains only HTML files.

## Features
- Single-page or multi-page HTML-based experience, including the new cooperative VolleySim experiment (`volleyball.html`)
- No build tools required
- Ready to open and play in any modern browser

## Getting started

1. Clone the repository:
   ```bash
   git clone https://github.com/Nomarcus/Foodsim.git
   cd Foodsim
   ```

2. Open the project in your browser:
   - Double-click `index.html` (or the main HTML file) or
   - Serve it locally (recommended for features that use fetch/APIs):
     ```bash
     # using Python 3
     python -m http.server 8000
     # then visit http://localhost:8000
     ```

## Project structure
- index.html — main entry point (may vary)
- assets/ — images, sounds, CSS, JS (if present)
- typesafe-tickets.js — TypeSafe ticket source for the data sorting simulation (see below)

Adjust paths and filenames as needed to match the repository contents.

## TypeSafe ticket classification (`foodsim_data_sorting.html`)

The data sorting simulation normally gives each ticket a random category, so the
agents are really only learning to match a colour. The **Ticket Source** panel in
the sidebar can switch this to **TypeSafe Jev**: tickets then carry real
natural-language support text, and the category is whatever Jev's `choice`
judgment returns for that text. That label becomes the ground truth the agents
are graded against, so the population is learning to route tickets classified
the way a triage desk would classify them.

Hovering a ticket shows its text, Jev's confidence, and the full probability
spread across the three categories — useful for seeing whether agents mis-sort
the tickets the model was least sure about.

### Comparing classifiers honestly

The corpus in `typesafe-tickets.js` carries a hand-written **gold label** per
ticket, following the ITIL distinction (incident = broken now, request = routine
provision, problem = the cause behind repeated failures). Three things are kept
strictly apart:

| | |
|---|---|
| **gold** | the correct category. The simulation grades against this. No classifier ever sees it, and it is never sent to the API. |
| **predicted** | what the selected classifier thought. This is what the agent is told it is carrying. |
| **confidence** | how sure the classifier was, as a distribution. |

When a classifier is wrong, the agent is misled — it carries the ticket to the
zone it was told, and the colony takes the penalty. Classification quality
therefore shows up directly in the simulation's score.

Two classifiers can be run on identical tickets against an identical answer key:

- **Keyword rules** — a hand-written no-AI baseline. Generic ITIL-ish cues only,
  with no phrases lifted from the corpus. It scores about **81%**: routine
  requests are easy to spot from polite phrasing, but it cannot tell a recurring
  fault from a one-off failure, so it loses most of its points on `problem`.
- **TypeSafe Jev** — the real System One API.

The **Classifier vs answer key** panel tallies both live, so switching source
compares them on the same stream. Hovering a ticket shows whether the classifier
got it right and what the truth was.

### Probability inputs

With **Feed probabilities to network** enabled (default), the three carried-ticket
inputs to the policy network carry Jev's probability distribution rather than a
hard one-hot of the selected category. A ticket the model found ambiguous arrives
as something like `[0.45, 0.35, 0.20]` instead of `[1, 0, 0]`.

Grading is unchanged — the ticket's true category is still the label Jev selected —
so agents must commit to a zone while seeing only how confident the classifier was.
Guessing well under uncertainty becomes part of what the population is selected for.

Turn the checkbox off to feed a one-hot instead, which makes it possible to A/B the
two signals against the same ticket stream. Synthetic tickets always use a one-hot,
since they have no distribution attached.

Implementation notes:
- Calls `POST https://api.typesafe.ai/v1/systemone` with the default `jev-latest`
  model. Eight tickets go out per request as independent `choice` questions over
  one shared state object, so they are answered in parallel in a single round trip.
- Labels are cached in `localStorage`, so re-running the simulation does not
  re-spend tokens on text that has already been classified. "Clear cached labels"
  resets this.
- Labelling is asynchronous and non-blocking. While the pool is still filling,
  tickets fall back to the original synthetic categories, so the simulation never
  stalls waiting on the API.
- Retries are applied to 408/429/5xx with exponential backoff; a 401/403/400/422
  stops labelling so a bad key does not loop against the rate limit.

### Deploying: the server proxy

`api.typesafe.ai` sends no CORS headers for arbitrary origins, so a browser
**cannot** call it directly — the request fails before it leaves the page, which
Safari reports as `Load failed`. On GitHub Pages or a plain file server, the
TypeSafe mode therefore cannot work on its own.

`api/typesafe.js` is a serverless function that solves this. Deploy the repo
somewhere that runs it (Vercel picks up `api/*.js` with no configuration), set
`TYPESAFE_API_KEY` in the deployment's environment variables, and the page will
find the proxy automatically on startup: the key field disappears, and requests
go same-origin.

The page probes `GET api/typesafe` when TypeSafe mode is switched on. If the
path 404s it falls back to calling the API directly and asks for a key, so the
same file works both ways.

> **Security:** with the proxy, the key stays on the server and never reaches the
> browser. Without it, the key is entered in the page and lives in `localStorage` —
> readable by anyone with access to that browser, and vulnerable to any script
> later added to the page. It is never committed either way.
>
> Note that a public proxy deployment will spend your tokens for anyone who finds
> the URL. The function caps questions per request (16) and body size (64 KB), but
> a spend limit on the API key itself is the real backstop.

With the source left on **Synthetic**, the simulation behaves exactly as before
and makes no network requests.

## Development
- Edit HTML, CSS, and JS files directly.
- No compilation step required.
- Use your browser dev tools to debug layout and scripts.

## Contribution
Contributions are welcome. Suggested workflow:
1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit changes: `git commit -m "Add feature"`
4. Push branch and open a pull request

Please include a short description of the change and any relevant screenshots or steps to test.

## License
This project is licensed under the MIT License. See LICENSE file for details.

## Notes / Next steps
- If you want, I can:
  - Add a short gameplay README section with controls and rules (tell me the controls/rules).
  - Generate badges (build/test/license) if you add CI or other metadata.
  - Create a CONTRIBUTING.md or CODE_OF_CONDUCT.md.
  - Update the README with the exact main HTML filename if it's not `index.html`.