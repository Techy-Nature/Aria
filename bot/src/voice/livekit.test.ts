import assert from "node:assert/strict";
import test from "node:test";
import type { AudioSource, LocalAudioTrack, Room } from "@livekit/rtc-node";
import { LiveKitVoiceTransport, type VoiceCredentials } from "./livekit.js";

const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; };

class FakeRoom {
  isConnected = false; disconnects = 0;
  localParticipant = { publishTrack: async () => {} };
  async connect() { this.isConnected = true; }
  async disconnect() { this.disconnects++; this.isConnected = false; }
}

class TestTransport extends LiveKitVoiceTransport {
  protected readonly label = "Test"; credentialCalls = 0; leaves = 0; rooms: FakeRoom[] = [];
  nextCredentials?: Promise<VoiceCredentials>;
  protected async credentials() { this.credentialCalls++; return this.nextCredentials ?? { endpoint: "wss://voice", token: "token" }; }
  protected async leaveSignaling() { this.leaves++; }
  protected createRoom() { const room = new FakeRoom(); this.rooms.push(room); return room as unknown as Room; }
  protected createAudioSource() { return {} as AudioSource; }
  protected createAudioTrack() { return {} as LocalAudioTrack; }
}

test("simultaneous same-channel connects share one in-flight session", async () => {
  const transport = new TestTransport(); const gate = deferred<VoiceCredentials>(); transport.nextCredentials = gate.promise;
  const first = transport.connect("guild", "channel"); const second = transport.connect("guild", "channel");
  assert.equal(transport.credentialCalls, 1); assert.equal(transport.channelId("guild"), "channel");
  gate.resolve({ endpoint: "wss://voice", token: "token" }); await Promise.all([first, second]);
  assert.equal(transport.rooms.length, 1); assert.equal(transport.isConnected("guild"), true);
  await transport.shutdown();
});

test("simultaneous different-channel connects retain the current-channel guard", async () => {
  const transport = new TestTransport(); const gate = deferred<VoiceCredentials>(); transport.nextCredentials = gate.promise;
  const first = transport.connect("guild", "one");
  await assert.rejects(transport.connect("guild", "two"), /already connected to another voice channel/);
  assert.equal(transport.credentialCalls, 1); gate.resolve({ endpoint: "wss://voice", token: "token" }); await first;
  assert.equal(transport.rooms.length, 1); await transport.shutdown();
});

test("a failed in-flight connect is removed and can be retried", async () => {
  const transport = new TestTransport(); const failure = deferred<VoiceCredentials>(); transport.nextCredentials = failure.promise;
  const first = transport.connect("guild", "channel"); failure.reject(new Error("assignment failed")); await assert.rejects(first, /assignment failed/);
  transport.nextCredentials = undefined; await transport.connect("guild", "channel");
  assert.equal(transport.credentialCalls, 2); assert.equal(transport.rooms.length, 1); await transport.shutdown();
});

test("disconnect invalidates an in-flight connect and cleans its signaling", async () => {
  const transport = new TestTransport(); const gate = deferred<VoiceCredentials>(); transport.nextCredentials = gate.promise;
  const connecting = transport.connect("guild", "channel"); const disconnecting = transport.disconnect("guild");
  gate.resolve({ endpoint: "wss://voice", token: "token" }); await assert.rejects(connecting, /cancelled/); await disconnecting;
  assert.equal(transport.isConnected("guild"), false); assert.equal(transport.rooms.length, 0); assert.equal(transport.leaves, 1);
  transport.nextCredentials = undefined; await transport.connect("guild", "channel"); await transport.disconnect("guild");
  assert.equal(transport.rooms.length, 1); assert.equal(transport.rooms[0].disconnects, 1); assert.equal(transport.isConnected("guild"), false);
});
