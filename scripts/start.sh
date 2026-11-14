#!/bin/sh
# Aria container entrypoint.
#
# Optional: route YouTube traffic through your home internet with Tailscale.
# Set TS_AUTHKEY (an ephemeral auth key) and TS_EXIT_NODE (your home computer's
# Tailscale name or 100.x address). Tailscale then runs in userspace mode with a
# local SOCKS5 proxy, and only yt-dlp is pointed at it. Voice (LiveKit) and chat
# traffic stay on Railway. Without TS_AUTHKEY this script just starts Aria.
set -eu

if [ -n "${TS_AUTHKEY:-}" ]; then
  SOCK=/tmp/tailscale/tailscaled.sock
  SOCKS_ADDR="${TS_SOCKS5_ADDR:-127.0.0.1:1055}"
  mkdir -p /tmp/tailscale
  tailscaled --tun=userspace-networking --socks5-server="$SOCKS_ADDR" --state=mem: --socket="$SOCK" \
    >/tmp/tailscale/tailscaled.log 2>&1 &

  i=0
  while [ ! -S "$SOCK" ] && [ "$i" -lt 30 ]; do i=$((i + 1)); sleep 0.5; done

  if tailscale --socket="$SOCK" up --timeout=60s --auth-key="$TS_AUTHKEY" --hostname="${TS_HOSTNAME:-aria-railway}" \
       ${TS_EXIT_NODE:+--exit-node="$TS_EXIT_NODE"} >/tmp/tailscale/up.log 2>&1; then
    if [ -n "${TS_EXIT_NODE:-}" ]; then
      echo "[Tailscale] connected; YouTube traffic goes through exit node $TS_EXIT_NODE"
      export YTDLP_PROXY="${YTDLP_PROXY:-socks5h://$SOCKS_ADDR}"
    else
      echo "[Tailscale] connected, but TS_EXIT_NODE is not set; YouTube traffic stays on Railway"
    fi
  else
    # Keep Aria running. Show the reason with any auth key redacted.
    echo "[Tailscale] could not connect; YouTube traffic stays on Railway. Check TS_AUTHKEY and TS_EXIT_NODE." >&2
    redact() { sed -E 's/tskey-[A-Za-z0-9_-]+/tskey-[REDACTED]/g' "$1" | tail -n 15 | sed 's/^/[Tailscale] /' >&2; }
    [ -f /tmp/tailscale/up.log ] && redact /tmp/tailscale/up.log
    [ -f /tmp/tailscale/tailscaled.log ] && redact /tmp/tailscale/tailscaled.log
  fi
  unset TS_AUTHKEY
fi

exec npm start
