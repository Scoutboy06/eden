#!/bin/sh
set -eu

if [ -r /etc/environment ]; then
  set -a
  . /etc/environment
  set +a
fi

mkdir -p /var/lib/tailscale
chmod 0700 /var/lib/tailscale
if [ -s /var/lib/tailscale/tailscaled.pid ]; then
  pid=$(cat /var/lib/tailscale/tailscaled.pid)
  kill "$pid" 2>/dev/null || true
  i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 10 ]; do
    sleep 1
    i=$((i + 1))
  done
fi
rm -f /var/lib/tailscale/tailscaled.pid
exec /usr/local/bin/tailscaled --tun=userspace-networking --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock --pidfile=/var/lib/tailscale/tailscaled.pid
