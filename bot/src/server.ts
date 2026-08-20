import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoopMode } from "./types.js";
import { PlayerManager } from "./player.js";
import { SearchService } from "./search.js";

export function createServer(players: PlayerManager, search: SearchService) {
  const app = express(); app.use(cors()); app.use(express.json());
  // Replace demo bearer tokens with Stoat/Fluxer OAuth validation before public deployment.
  const auth: express.RequestHandler = (req, res, next) => { if (!req.headers.authorization?.startsWith("Bearer ")) return res.status(401).json({ error: "Sign in required" }); next(); };
  app.get("/api/auth/:platform", (req, res) => res.redirect(`/?token=demo-${encodeURIComponent(req.params.platform)}`));
  app.get("/api/state", auth, (req, res) => res.json(players.snapshot(String(req.query.guild ?? "demo"))));
  app.get("/api/search", auth, async (req, res, next) => { try { res.json(await search.search(String(req.query.q ?? ""), 8)); } catch (e) { next(e); } });
  app.post("/api/queue", auth, (req, res) => { players.add(String(req.body.guildId ?? "demo"), [req.body.track]); res.status(201).json(players.snapshot(String(req.body.guildId ?? "demo"))); });
  app.post("/api/control/:action", auth, (req, res) => { const g = String(req.body.guildId ?? "demo"); const action = req.params.action;
    if (action === "play") players.pause(g); else if (action === "next") players.skip(g); else if (action === "previous") players.previous(g); else if (action === "rewind") players.rewind(g); else if (action === "loop") { const current = players.get(g).loop; players.setLoop(g, ({ off: "song", song: "playlist", playlist: "off" } as Record<LoopMode, LoopMode>)[current]); }
    res.json(players.snapshot(g)); });
  const dashboard = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dashboard"); app.use(express.static(dashboard)); app.get("*", (_req, res) => res.sendFile(path.join(dashboard, "index.html")));
  return app;
}
