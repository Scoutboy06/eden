#!/bin/sh
set -eu

version=1.104.7
archive="tailscale_${version}_amd64.tgz"
expected=e56693ff74a64f2591b7e819c280635a100aae1ddfb0ef058fcd052b7cd8d16c
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "https://pkgs.tailscale.com/stable/$archive" -o "$tmp/$archive"
printf '%s  %s\n' "$expected" "$tmp/$archive" | sha256sum -c -
tar -xzf "$tmp/$archive" -C "$tmp"
install -d -m 0755 /usr/local/bin
install -m 0755 "$tmp/tailscale_${version}_amd64/tailscale" /usr/local/bin/tailscale
install -m 0755 "$tmp/tailscale_${version}_amd64/tailscaled" /usr/local/bin/tailscaled
