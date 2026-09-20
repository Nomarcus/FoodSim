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

> **Security:** this mode calls the API directly from the browser, so the API key
> is readable by anyone who can open the page. It is stored in `localStorage` and
> never committed. Use it only on a local copy — **do not paste a key into a
> publicly hosted deployment** (e.g. GitHub Pages). A server-side proxy holding
> the key is the right approach for anything shared.

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