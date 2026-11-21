# BTC Options Block Volume Profile Tracker

Project split for readability: HTML, CSS, and JS are separated.

Files:
- `index.html` — main HTML shell, loads external assets.
- `src/css/styles.css` — extracted styles.
- `src/js/app.js` — all JavaScript logic (parsing, API fetch, Chart rendering).

How to run:
1. Install Node.js 20 or newer.
2. Run `npm ci` and `npm run build`.
3. Open `dist/index.html` in a browser, then use the Upload JSONL panel or Deribit API pull to populate the dashboard.

Run `npm run check` and `npm test` to validate the JavaScript and core chart/view calculations.

## Deploy to GitHub Pages

The `Deploy dashboard to GitHub Pages` workflow checks the JavaScript, builds minimized Tailwind CSS, and publishes the static app whenever changes are pushed to `main`, or when started manually from the Actions tab. No repository secrets are required.

To enable deployment:
1. Push the repository to GitHub.
2. In **Settings > Pages**, set the source to **GitHub Actions**.
3. Push to `main` or run the workflow from **Actions**.

The project-page URL is `https://<owner>.github.io/<repository>/`. App assets use relative paths, so the same files work at the repository subpath. This is a single-page dashboard without client-side routes, so a separate SPA fallback page is not needed.

Notes:
- The page uses CDN-hosted Chart.js and Google Fonts.
- Tailwind utility classes are compiled into static CSS during the build; the browser does not run the Tailwind CDN compiler.
- Live data comes from Deribit's public endpoints in the browser; requests remain subject to network access and provider rate limits.
- After positions render, RFQs with at least 200 total contracts automatically fetch prices in descending contract size. Ticker requests are serialized globally with a one-second gap between requests. Smaller RFQs remain manual. If a leg quote is rejected, successful leg values still update and the RFQ is marked partial so missing quotes can be retried.
- Keep functions that are invoked from HTML (e.g., `startLiveApiEngine`) in global scope — `src/js/app.js` is a standard script.
