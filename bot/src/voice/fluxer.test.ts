import assert from "node:assert/strict";
import test from "node:test";
import type { AudioSource, LocalAudioTrack, Room } from "@livekit/rtc-node";
import { FluxerVoiceTransport, type FluxerVoiceGateway } from "./fluxer.js";
import type { VoiceCredentials } from "./livekit.js";

class Gateway implements FluxerVoiceGateway {
  requests: Array<[string, string | null, string | undefined]> = [];
  resolve!: (credentials: VoiceCredentials & { connectionId: string }) => void;
  requestVoice(guildId: string, channelId: string | null, connectionId?: string) { this.requests.push([guildId, channelId, connectionId]); }
  waitForVoiceServer() { return new Promise<VoiceCredentials & { connectionId: string }>(resolve => { this.resolve = resolve; }); }
}
class FakeRoom { isConnected = false; localParticipant = { publishTrack: async () => {} }; async connect() { this.isConnected = true; } async disconnect() { this.isConnected = false; } }
class TestFluxerTransport extends FluxerVoiceTransport {
  rooms: FakeRoom[] = [];
  protected createRoom() { const room = new FakeRoom(); this.rooms.push(room); return room as unknown as Room; }
  protected createAudioSource() { return {} as AudioSource; }
  protected createAudioTrack() { return {} as LocalAudioTrack; }
}

test("concurrent Fluxer connects send one gateway join and share its connection id", async () => {
  const gateway = new Gateway(); const transport = new TestFluxerTransport(gateway);
  const first = transport.connect("guild", "channel"); const second = transport.connect("guild", "channel");
  assert.deepEqual(gateway.requests, [["guild", "channel", undefined]]);
  gateway.resolve({ endpoint: "wss://voice", token: "token", connectionId: "connection" }); await Promise.all([first, second]);
  assert.equal(transport.rooms.length, 1); await transport.disconnect("guild");
  assert.deepEqual(gateway.requests[1], ["guild", null, "connection"]);
});
