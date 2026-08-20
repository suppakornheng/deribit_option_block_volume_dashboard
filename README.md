# BTC Options Block Volume Profile Tracker

Project split for readability: HTML, CSS, and JS are separated.

Files:
- `index.html` — main HTML shell, loads external assets.
- `src/css/styles.css` — extracted styles.
- `src/js/app.js` — all JavaScript logic (parsing, API fetch, Chart rendering).

How to run:
1. Open `index.html` in a browser (no build step required).
2. Use the Upload JSONL panel or the Deribit API pull to populate the dashboard.

Notes:
- The page uses CDN-hosted Chart.js and Tailwind CSS.
- Keep functions that are invoked from HTML (e.g., `startLiveApiEngine`) in global scope — `src/js/app.js` is a standard script.
