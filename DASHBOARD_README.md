# Aria dashboard

The dashboard is a responsive, static HTML/CSS/JavaScript player in this directory. It is served by the bot in production and can also be published on GitHub Pages.

## Run locally

From the repository root, install and run Aria (`npm install && npm run dev`), then open `http://localhost:3000`. The API and static site share an origin by default.

## Host on GitHub Pages

The dashboard can be published directly to GitHub Pages via the included GitHub Actions workflow (`.github/workflows/deploy-dashboard.yml`).

1. Enable GitHub Pages in your repository settings under **Settings > Pages** and set **Source** to **GitHub Actions**.
2. To connect the GitHub Pages player to your backend bot:
   - **Option A (Code configuration):** Set `DEFAULT_API_BASE` at the top of `dashboard/app.js` (e.g. `const DEFAULT_API_BASE = "https://your-bot.onrender.com";`).
   - **Option B (URL query parameter):** Open the GitHub Pages dashboard once with `?api=https://your-bot.onrender.com`. The URL will be saved to your browser's local storage automatically.
3. Make sure your bot backend (in `bot/`) is hosted on a persistent Node host (Render, Railway, Fly.io, etc.).

## Authentication and security

The included callback creates a **demo token only**, so local development is immediate. Before public deployment, register OAuth applications with Stoat and Fluxer, redirect `/api/auth/:platform` to the provider, validate the callback server-side, and store an encrypted, HTTP-only session. Never put bot tokens or OAuth client secrets in this directory.

The player discovers the signed-in user's guild and voice state through `/api/state`, searches through `/api/search`, and sends controls through `/api/control/:action`. Right-click any search result to open the provider URL without queueing it. Theme and accent choices are stored in local storage; WCAG-style luminance calculations automatically choose light or dark text.
