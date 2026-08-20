import test from "node:test"; import assert from "node:assert/strict"; import { PlayerManager } from "./player.js";
const track = (id: string) => ({ id, title: id, artist: "artist", url: id, duration: 1 });
test("queue controls and loop cycle state", () => { const p = new PlayerManager(); p.add("g", [track("one"), track("two")]); p.skip("g"); assert.equal(p.get("g").index, 1); p.previous("g"); assert.equal(p.get("g").index, 0); p.setLoop("g", "song"); p.skip("g"); assert.equal(p.get("g").index, 0); });
