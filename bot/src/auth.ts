import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

const AUTHORIZE_URL = "https://api.fluxer.app/v1/oauth2/authorize";
const TOKEN_URL = "https://api.fluxer.app/v1/oauth2/token";
const USER_URL = "https://api.fluxer.app/v1/oauth2/userinfo";
const STATE_TTL = 10 * 60_000;

type PendingLogin = { verifier: string; returnTo: string; expiresAt: number };
type Session = { userId: string; expiresAt: number };
type TokenResponse = { access_token?: string; expires_in?: number };

function cookies(header: string | undefined) {
  return Object.fromEntries((header ?? "").split(";").map(value => value.trim().split(/=(.*)/s).slice(0, 2)).filter(([key]) => key));
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createFluxerAuth(fetcher: typeof fetch = fetch) {
  const states = new Map<string, PendingLogin>();
  const sessions = new Map<string, Session>();
  const secure = process.env.NODE_ENV === "production";
  const cookieOptions = `HttpOnly; Path=/; SameSite=${secure ? "None" : "Lax"}${secure ? "; Secure" : ""}`;

  const configured = () => Boolean(process.env.FLUXER_CLIENT_ID && process.env.FLUXER_CLIENT_SECRET && process.env.PUBLIC_URL);
  const callbackUrl = () => new URL("/api/auth/fluxer/callback", process.env.PUBLIC_URL).toString();
  const allowedReturnTo = (candidate: unknown) => {
    const fallback = process.env.DASHBOARD_URL || process.env.PUBLIC_URL || "/";
    try {
      const target = new URL(typeof candidate === "string" ? candidate : fallback, process.env.PUBLIC_URL);
      const allowed = new Set([new URL(fallback, process.env.PUBLIC_URL).origin, new URL(process.env.PUBLIC_URL!).origin]);
      return allowed.has(target.origin) ? target.toString() : fallback;
    } catch { return fallback; }
  };

  const begin: RequestHandler = (req, res) => {
    if (!configured()) return res.status(503).json({ error: "Fluxer login is not configured" });
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    states.set(state, { verifier, returnTo: allowedReturnTo(req.query.return_to), expiresAt: Date.now() + STATE_TTL });
    res.setHeader("Set-Cookie", `aria_oauth_state=${state}; Max-Age=600; ${cookieOptions}`);
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({ client_id: process.env.FLUXER_CLIENT_ID!, redirect_uri: callbackUrl(), response_type: "code", scope: "identify", state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
    res.redirect(url.toString());
  };

  const callback: RequestHandler = async (req, res, next) => {
    try {
      if (!configured()) return res.status(503).json({ error: "Fluxer login is not configured" });
      const state = String(req.query.state ?? "");
      const pending = states.get(state);
      states.delete(state);
      const stateCookie = cookies(req.headers.cookie).aria_oauth_state ?? "";
      if (!pending || pending.expiresAt < Date.now() || !safeEqual(state, stateCookie)) return res.status(400).json({ error: "Invalid or expired OAuth state" });
      const code = String(req.query.code ?? "");
      if (!code) return res.status(400).json({ error: "Fluxer did not return an authorization code" });
      const tokenResponse = await fetcher(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callbackUrl(), client_id: process.env.FLUXER_CLIENT_ID!, client_secret: process.env.FLUXER_CLIENT_SECRET!, code_verifier: pending.verifier }) });
      if (!tokenResponse.ok) return res.status(502).json({ error: "Fluxer rejected the authorization code" });
      const token = await tokenResponse.json() as TokenResponse;
      if (!token.access_token) return res.status(502).json({ error: "Fluxer returned an invalid token response" });
      const userResponse = await fetcher(USER_URL, { headers: { Authorization: `Bearer ${token.access_token}` } });
      if (!userResponse.ok) return res.status(502).json({ error: "Could not verify the Fluxer account" });
      const user = await userResponse.json() as { id?: string };
      if (!user.id) return res.status(502).json({ error: "Fluxer returned an invalid user response" });
      const sessionId = randomBytes(32).toString("base64url");
      sessions.set(sessionId, { userId: user.id, expiresAt: Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000 });
      res.setHeader("Set-Cookie", [`aria_session=${sessionId}; ${cookieOptions}`, `aria_oauth_state=; Max-Age=0; ${cookieOptions}`]);
      res.redirect(pending.returnTo);
    } catch (error) { next(error); }
  };

  const requireSession: RequestHandler = (req, res, next) => {
    const id = cookies(req.headers.cookie).aria_session;
    const session = id && sessions.get(id);
    if (!session || session.expiresAt < Date.now()) {
      if (id) sessions.delete(id);
      return res.status(401).json({ error: "Sign in with Fluxer" });
    }
    next();
  };

  return { begin, callback, requireSession };
}
