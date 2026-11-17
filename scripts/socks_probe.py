#!/usr/bin/env python3
"""Checks the Tailscale SOCKS5 proxy at startup and prints one line per test.

Usage: socks_probe.py HOST:PORT
Tests a connection by IP address (1.1.1.1:443) and by name
(www.youtube.com:443). If the IP works but the name fails, the exit node
forwards traffic but name lookups through it fail.
"""
import socket
import struct
import sys

REPLIES = {1: "general SOCKS server failure", 2: "not allowed", 3: "network unreachable", 4: "host unreachable",
           5: "connection refused", 6: "TTL expired", 7: "command not supported", 8: "address type not supported"}


def probe(proxy_host, proxy_port, target, port, by_name):
    try:
        with socket.create_connection((proxy_host, proxy_port), timeout=15) as s:
            s.settimeout(15)
            s.sendall(b"\x05\x01\x00")
            if s.recv(2) != b"\x05\x00":
                return "proxy refused the handshake"
            if by_name:
                name = target.encode()
                req = b"\x05\x01\x00\x03" + bytes([len(name)]) + name
            else:
                req = b"\x05\x01\x00\x01" + socket.inet_aton(target)
            s.sendall(req + struct.pack("!H", port))
            reply = s.recv(4)
            if len(reply) < 2:
                return "no reply from proxy"
            return "ok" if reply[1] == 0 else REPLIES.get(reply[1], f"error {reply[1]}")
    except OSError as error:
        return f"failed ({error.__class__.__name__})"


def main():
    host, _, port = sys.argv[1].rpartition(":")
    by_ip = probe(host, int(port), "1.1.1.1", 443, False)
    by_name = probe(host, int(port), "www.youtube.com", 443, True)
    print(f"[Tailscale] exit node check: internet by IP {by_ip}; youtube.com by name {by_name}", flush=True)
    if by_ip != "ok":
        print("[Tailscale] the exit node is not forwarding traffic. On that device, turn on 'Run as exit node', "
              "and in the admin console approve it under Edit route settings > Use as exit node.", flush=True)
    elif by_name != "ok":
        print("[Tailscale] the exit node forwards traffic, but name lookups through it fail.", flush=True)


if __name__ == "__main__":
    main()
