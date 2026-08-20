# Aria dashboard

The dashboard is a responsive, static HTML/CSS/JavaScript player in this directory. It is served by the bot in production and can also be published on GitHub Pages.

## Run locally

From the repository root, install and run Aria (`npm install && npm run dev`), then open `http://localhost:3000`. The API and static site share an origin by default.

For GitHub Pages, publish the `dashboard/` directory and change the API paths at the top of `app.js` to the public URL of your separately hosted bot API. GitHub Pages cannot run the Node API or keep a bot connected; deploy `bot/` to a persistent Node host.

## Authentication and security

The included callback creates a **demo token only**, so local development is immediate. Before public deployment, register OAuth applications with Stoat and Fluxer, redirect `/api/auth/:platform` to the provider, validate the callback server-side, and store an encrypted, HTTP-only session. Never put bot tokens or OAuth client secrets in this directory.

The player discovers the signed-in user's guild and voice state through `/api/state`, searches through `/api/search`, and sends controls through `/api/control/:action`. Right-click any search result to open the provider URL without queueing it. Theme and accent choices are stored in local storage; WCAG-style luminance calculations automatically choose light or dark text.
