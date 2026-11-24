import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

export type RouteCheck = { ok: true; ms: number } | { ok: false; ms: number; reason: string };

/** The SOCKS5 proxy a YTDLP_PROXY value names, or undefined when it can't be checked this way (http proxies, or ones with a password). */
export function socksProxy(value: string | undefined): { host: string; port: number } | undefined {
  const proxy = value?.trim(); if (!proxy) return undefined;
  let url: URL; try { url = new URL(proxy); } catch { return undefined; }
  if (url.protocol !== "socks5:" && url.protocol !== "socks5h:") return undefined;
  if (url.username || url.password) return undefined;
  const port = Number(url.port || 1080); const host = url.hostname.replace(/^\[|\]$/g, "");
  return host && Number.isInteger(port) && port > 0 && port < 65536 ? { host, port } : undefined;
}

const SOCKS_REPLIES: Record<number, string> = { 1: "general SOCKS server failure", 2: "not allowed", 3: "network unreachable", 4: "host unreachable", 5: "connection refused", 6: "TTL expired", 7: "command not supported", 8: "address type not supported" };

/**
 * Opens a real HTTPS connection to `target` through a SOCKS5 proxy and finishes the TLS handshake.
 * A SOCKS "ok" alone isn't proof: Tailscale's userspace proxy can answer before any data has crossed
 * the exit node, so this only counts as working once the remote server has actually answered.
 */
export function checkSocksRoute(proxy: { host: string; port: number }, target = "www.youtube.com", targetPort = 443, timeoutMs = 10_000): Promise<RouteCheck> {
  const started = Date.now();
  return new Promise(resolve => {
    let done = false; let socket: Socket | undefined; let tlsSocket: ReturnType<typeof tlsConnect> | undefined;
    const finish = (reason?: string) => {
      if (done) return; done = true; clearTimeout(timer);
      tlsSocket?.destroy(); socket?.destroy();
      const ms = Date.now() - started; resolve(reason ? { ok: false, ms, reason } : { ok: true, ms });
    };
    const timer = setTimeout(() => finish(`no answer within ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    let buffer = Buffer.alloc(0); let stage: "greeting" | "reply" | "tls" = "greeting";
    socket = netConnect(proxy.port, proxy.host);
    socket.on("error", error => finish(`proxy connection failed (${(error as NodeJS.ErrnoException).code ?? error.message})`));
    socket.on("close", () => finish("proxy closed the connection"));
    socket.on("connect", () => socket!.write(Buffer.from([5, 1, 0])));
    socket.on("data", chunk => {
      if (stage === "tls") return;
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "greeting") {
        if (buffer.length < 2) return;
        if (buffer[0] !== 5 || buffer[1] !== 0) return finish("proxy refused the handshake");
        buffer = buffer.subarray(2); stage = "reply";
        const name = Buffer.from(target);
        socket!.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([targetPort >> 8, targetPort & 255])]));
      }
      if (stage === "reply") {
        if (buffer.length < 5) return;
        if (buffer[1] !== 0) return finish(SOCKS_REPLIES[buffer[1]] ?? `SOCKS error ${buffer[1]}`);
        const length = buffer[3] === 1 ? 10 : buffer[3] === 4 ? 22 : buffer[3] === 3 ? 7 + buffer[4] : -1;
        if (length < 0) return finish("proxy sent an unknown address type");
        if (buffer.length < length) return;
        stage = "tls"; socket!.removeAllListeners("data"); socket!.removeAllListeners("close");
        socket!.on("close", () => finish("connection closed before YouTube answered"));
        tlsSocket = tlsConnect({ socket: socket!, servername: target });
        tlsSocket.on("secureConnect", () => finish());
        tlsSocket.on("error", error => finish(`YouTube's TLS handshake failed (${(error as NodeJS.ErrnoException).code ?? error.message})`));
      }
    });
  });
}
