import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "./server.js";
import { PlayerManager } from "./player.js";
import { SearchService } from "./search.js";

test("Fluxer authorization callback creates a server-side session", async t => {
  const original = { ...process.env };
  process.env.PUBLIC_URL = "http://localhost:3000";
  process.env.DASHBOARD_URL = "http://dashboard.test";
  process.env.FLUXER_CLIENT_ID = "client-id";
  process.env.FLUXER_CLIENT_SECRET = "client-secret";
  t.after(() => { process.env = original; });

  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/oauth2/token")) return Response.json({ access_token: "provider-token", expires_in: 600 });
    return Response.json({ id: "fluxer-user" });
  };
  const server = createServer(new PlayerManager(), new SearchService(), fetcher as typeof fetch).listen(0);
  t.after(() => server.close());
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const start = await fetch(`${base}/api/auth/fluxer?return_to=${encodeURIComponent("http://dashboard.test/player")}`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("location")!);
  assert.equal(authorize.origin + authorize.pathname, "https://api.fluxer.app/v1/oauth2/authorize");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  const state = authorize.searchParams.get("state")!;
  const stateCookie = start.headers.get("set-cookie")!.match(/aria_oauth_state=[^;]+/)![0];

  const callback = await fetch(`${base}/api/auth/fluxer/callback?code=valid-code&state=${encodeURIComponent(state)}`, { headers: { cookie: stateCookie }, redirect: "manual" });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "http://dashboard.test/player");
  assert.equal(calls[0].url, "https://api.fluxer.app/v1/oauth2/token");
  assert.match(String(calls[0].init?.body), /client_secret=client-secret/);
  assert.equal(calls[1].url, "https://api.fluxer.app/v1/oauth2/userinfo");
  assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, "Bearer provider-token");

  const sessionCookie = callback.headers.get("set-cookie")!.match(/aria_session=[^;]+/)![0];
  const stateResponse = await fetch(`${base}/api/state`, { headers: { cookie: sessionCookie } });
  assert.equal(stateResponse.status, 200);
});

test("demo bearer tokens are rejected and Stoat login is disabled", async t => {
  const server = createServer(new PlayerManager(), new SearchService()).listen(0);
  t.after(() => server.close());
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${base}/api/state`, { headers: { Authorization: "Bearer demo-fluxer" } })).status, 401);
  const stoat = await fetch(`${base}/api/auth/stoat`);
  assert.equal(stoat.status, 503);
  assert.match((await stoat.json()).error, /temporarily unavailable/);
});
