#!/usr/bin/env bash
# One-time setup of Cozy Bistro's database on the shared box. Safe to re-run:
# every step checks whether it is already done. Touches only /opt/cozy-bistro,
# one fstab line, and the docker network cozybistro_net.
set -euo pipefail

ROOT=/opt/cozy-bistro
IMG=$ROOT/data.img
MNT=$ROOT/data
SIZE=8G          # hard cap for ALL database data (log, snapshots, server logs)

mkdir -p "$ROOT" "$MNT"

# 1. Fixed-size filesystem in a file. Sparse: it uses real disk only as it
#    fills, but can never grow past $SIZE.
if [ ! -f "$IMG" ]; then
  echo "free space before:"; df -h / | tail -1
  truncate -s "$SIZE" "$IMG"
  mkfs.ext4 -q -F -m 0 -L cozybistro "$IMG"
fi
if ! grep -q "^$IMG " /etc/fstab; then
  cp /etc/fstab "/etc/fstab.bak-$(date +%Y%m%d-%H%M%S)"
  echo "$IMG $MNT ext4 loop,nofail,noatime 0 0" >> /etc/fstab
fi
mountpoint -q "$MNT" || mount "$MNT"
chown 1000:1000 "$MNT"

# 2. Own docker network (box rule: new apps get their own network).
docker network inspect cozybistro_net >/dev/null 2>&1 || docker network create cozybistro_net

# 3. First start writes the default config; then tune it and restart.
cd "$ROOT"
docker compose up -d
for i in $(seq 1 30); do
  curl -fsS -m 2 http://127.0.0.1:3100/v1/ping >/dev/null 2>&1 && break; sleep 1
done
CFG=$MNT/config.toml
if grep -q '^# max-segment-size' "$CFG"; then
  # 64 MiB log pieces: a snapshot at every rotation (at least daily for this
  # game), and finished pieces get compressed and become prunable.
  sed -i 's/^# max-segment-size = .*/max-segment-size = 67108864/' "$CFG"
  # Server log at info level; the default debug level grows much faster.
  # (The nightly job also empties a server log that passes 50 MB.)
  sed -i 's/"spacetimedb\(_[a-z_]*\)\?=debug"/"spacetimedb\1=info"/' "$CFG"
  docker compose restart
fi
for i in $(seq 1 30); do
  curl -fsS -m 2 http://127.0.0.1:3100/v1/ping >/dev/null 2>&1 && break; sleep 1
done

echo "--- result"
df -h "$MNT" | tail -1
grep -n '^max-segment-size' "$CFG"
docker ps --filter name=cozybistro-stdb --format '{{.Names}} {{.Status}}'
curl -fsS -m 3 -o /dev/null -w 'ping %{http_code}\n' http://127.0.0.1:3100/v1/ping
