#!/usr/bin/env python3
"""Checks the Tailscale SOCKS5 proxy at startup and prints one line per test.

Usage: socks_probe.py HOST:PORT
Tests a connection by IP address (1.1.1.1:443) and by name
(www.youtube.com:443). If the IP works but the name fails, the exit node
forwards traffic but name lookups through it fail.
"""
import socket
import ssl
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
            if reply[1] != 0:
                return REPLIES.get(reply[1], f"error {reply[1]}")
            if not by_name:
                return "ok"
            # A SOCKS "ok" can come back before anything has crossed the exit node,
            # so for the name test also finish a real TLS handshake with the site.
            rest = {1: 6, 4: 18}.get(reply[3]) if len(reply) == 4 else None
            if rest is None and len(reply) == 4 and reply[3] == 3:
                rest = s.recv(1)[0] + 2
            if rest:
                s.recv(rest)
            with ssl.create_default_context().wrap_socket(s, server_hostname=target):
                return "ok"
    except ssl.SSLError as error:
        return f"TLS failed ({error.__class__.__name__})"
    except OSError as error:
        return f"failed ({error.__class__.__name__})"


def main():
    host, _, port = sys.argv[1].rpartition(":")
    by_ip = probe(host, int(port), "1.1.1.1", 443, False)
    by_name = probe(host, int(port), "www.youtube.com", 443, True)
    print(f"[Tailscale] exit node check: internet by IP {by_ip}; youtube.com by name (with TLS) {by_name}", flush=True)
    if by_ip != "ok":
        print("[Tailscale] the exit node is not forwarding traffic. On that device, turn on 'Run as exit node', "
              "and in the admin console approve it under Edit route settings > Use as exit node.", flush=True)
    elif by_name != "ok":
        print("[Tailscale] the exit node forwards traffic, but name lookups through it fail.", flush=True)


if __name__ == "__main__":
    main()
