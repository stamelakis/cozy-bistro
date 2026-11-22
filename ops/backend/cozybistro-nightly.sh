#!/usr/bin/env bash
# Nightly job for Cozy Bistro's database. On the box at /opt/cozybistro-nightly.sh,
# run by /etc/cron.d/cozybistro-nightly at 03:30 UTC (before the off-site push,
# 03:40). About 10 seconds of downtime: players see "Lost connection" and the
# game reconnects.
#
#   1. STOP the database (a cold copy is the only backup we know is consistent).
#   2. PRUNE. SpacetimeDB's commit log only ever grows. The server takes a
#      snapshot at every log rotation, and on restart it needs only a snapshot
#      plus the log written after it. We keep the newest KEEP_SNAPSHOTS
#      PROVEN snapshots and the log from the older of them onward, and delete
#      the rest. Tested on v2.3.0 (Linux), 2026-11-22: restart, data, writes fine.
#   3. BACKUP: tar of the pruned data folder (it includes the signing keys in
#      keys/), piped straight into age. Never a plaintext copy. The private
#      half of the age key lives off the box (Andreas's password manager).
#   4. START, wait for ping, mail the owner if anything went wrong.
#
# Do not "simplify" step 2 away: without it the disk fills. That is what
# killed the previous host of this game (docs in ops/backend/README.md).
#
# Every path and command can be moved by an environment variable (for tests).
set -uo pipefail
umask 077

DATA=${DATA:-/opt/cozy-bistro/data}
CONTAINER=${CONTAINER:-cozybistro-stdb}
PING_URL=${PING_URL:-http://127.0.0.1:3100/v1/ping}
DEST=${DEST:-/opt/backups}
PUB=${PUB:-/opt/cozybistro-backup.pub}
AGE=${AGE:-age}
DOCKER=${DOCKER:-docker}
OWNER_MAIL=${OWNER_MAIL:-/opt/owner-mail.py}
KEEP_SNAPSHOTS=${KEEP_SNAPSHOTS:-2}
KEEP_BACKUPS=${KEEP_BACKUPS:-7}
WARN_PCT=${WARN_PCT:-60}
STAMP=${STAMP:-$(date -u +%Y%m%d-%H%M%S)}
OUT="$DEST/cozybistro-$STAMP.tar.gz.age"

log(){ echo "$(date -Is) $*"; }
problems=""
problem(){ log "PROBLEM: $*"; problems="$problems
- $*"; }
num(){ echo $((10#$1)); }   # zero-padded offset -> number
ping_ok(){ [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$PING_URL" 2>/dev/null)" = "200" ]; }
running(){ [ "$("$DOCKER" inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]; }
sealed(){ [ -s "$1" ] && [ "$(head -c 21 "$1")" = "age-encryption.org/v1" ]; }
trap 'rm -f "$OUT.part"' EXIT

finish(){
  # Whatever happened above, the game must be running when we leave.
  running || "$DOCKER" start "$CONTAINER" >/dev/null 2>&1 || problem "could not start $CONTAINER"
  local up=0 i
  for i in $(seq 1 60); do ping_ok && { up=1; break; }; sleep 1; done
  if [ "$up" = 1 ]; then log "database is up"; else problem "the database did not answer within 60s"; fi

  local pct; pct=$(df --output=pcent "$DATA" 2>/dev/null | tail -1 | tr -dc '0-9')
  log "data space used: ${pct:-?}%"
  [ "${pct:-0}" -ge "$WARN_PCT" ] && problem "the game's data space is ${pct}% full (the cap is fixed; pruning should keep it far lower)"

  if [ -n "$problems" ] && [ -x "$OWNER_MAIL" ]; then
    printf 'Cozy Bistro, νυχτερινή εργασία της βάσης (%s):\n%s\n\nΑρχείο καταγραφής: /var/log/cozybistro-nightly.log\n' \
      "$(TZ=Europe/Athens date '+%d/%m/%Y %H:%M')" "$problems" \
      | timeout 120 "$OWNER_MAIL" --tag cozybistro-nightly --cap 3 --name "Cozy Bistro · Server" \
          --subject "🟠 Cozy Bistro: πρόβλημα στη νυχτερινή εργασία της βάσης" >/dev/null 2>&1 \
      || log "alert not sent"
  fi
  [ -z "$problems" ]; exit $?
}

[ -d "$DATA/replicas" ] || { problem "no $DATA/replicas: is the data folder mounted?"; finish; }
mkdir -p "$DEST"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$DEST/.cozybistro-nightly.lock"
  flock -n 9 || { log "another run is still going -- leaving"; exit 1; }
fi
for f in "$DEST"/cozybistro-*.age.part; do [ -e "$f" ] && rm -f "$f"; done

# ---- 0. gate: only a database that is healthy RIGHT NOW gets pruned. ----
# A database that crashed (full disk above all) leaves half-written log tails
# and snapshots of changes that never reached the log. Pruning by those
# deletes the only good history. Proven the hard way in the 2026-11-22 lab.
if ! ping_ok; then
  problem "the database was not answering BEFORE the nightly job, so nothing was stopped, pruned or backed up. Fix it by hand (README: 'If the data space is full'); never prune a broken database"
  finish
fi

# ---- 1. stop. Nothing below may touch the files of a RUNNING database. ----
log "stopping database"
"$DOCKER" stop -t 10 "$CONTAINER" >/dev/null 2>&1
if running; then problem "could not stop $CONTAINER: nothing pruned, no backup"; finish; fi

# ---- 2. prune, per database ("replica") ----
for rep in "$DATA"/replicas/*/; do
  rep=${rep%/}
  [ -d "$rep/clog" ] && [ -d "$rep/snapshots" ] || continue
  mapfile -t segs < <(ls "$rep/clog" | grep -E '^[0-9]{20}\.stdb\.log$' | sort)
  [ "${#segs[@]}" -ge 1 ] || continue
  newest_seg=$(num "${segs[$(( ${#segs[@]} - 1 ))]%%.*}")
  # A snapshot counts only if a LATER log piece exists: that proves the log
  # really reached past it on disk. Snapshots inside the newest piece (the
  # normal newest one, or leftovers of a crash) are never counted or touched.
  snaps=()
  while read -r sn; do
    [ -n "$sn" ] && [ "$(num "${sn%%.*}")" -lt "$newest_seg" ] && snaps+=("$sn")
  done < <(ls "$rep/snapshots" | grep -E '^[0-9]{20}\.snapshot_dir$' | sort)
  if [ "${#snaps[@]}" -le "$KEEP_SNAPSHOTS" ]; then
    log "db $(basename "$rep"): ${#snaps[@]} proven snapshot(s), nothing to prune"; continue
  fi
  oldest_kept=${snaps[$(( ${#snaps[@]} - KEEP_SNAPSHOTS ))]}
  keep_offset=$(num "${oldest_kept%%.*}")
  # The log piece that holds keep_offset is the last one that starts at or before it.
  holder=""
  for s in "${segs[@]}"; do
    [ "$(num "${s%%.*}")" -le "$keep_offset" ] && holder=$s
  done
  if [ -z "$holder" ]; then
    problem "db $(basename "$rep"): no log piece covers snapshot $keep_offset, pruned nothing"; continue
  fi
  removed=0
  for s in "${segs[@]}"; do
    [ "$s" \< "$holder" ] || break
    rm -f "$rep/clog/$s" "$rep/clog/${s%.log}.ofs" && removed=$((removed + 1))
  done
  for sn in "${snaps[@]}"; do
    [ "$sn" \< "$oldest_kept" ] || break
    rm -rf "${rep:?}/snapshots/$sn"
  done
  log "db $(basename "$rep"): kept the snapshots from offset $keep_offset on, removed $removed old log piece(s)"
done

# ---- housekeeping: the server's own text logs share the capped space ----
find "$DATA/logs" "$DATA"/replicas/*/module_logs -type f -mtime +14 -delete 2>/dev/null
for f in "$DATA"/logs/*.log; do
  [ -f "$f" ] && [ "$(stat -c %s "$f")" -gt 52428800 ] && : > "$f"
done

# ---- 3. backup (the database is stopped, so the copy is consistent) ----
if [ ! -s "$PUB" ] || ! command -v "$AGE" >/dev/null 2>&1; then
  problem "NO BACKUP: the age public key ($PUB) or the age tool is missing"
elif tar -C "$DATA" --exclude=./cache --exclude=./logs --exclude=./lost+found --exclude=./spacetime.pid -czf - . \
       | "$AGE" -R "$PUB" -o "$OUT.part" && sealed "$OUT.part" && mv -f "$OUT.part" "$OUT"; then
  log "encrypted backup: $OUT ($(du -h "$OUT" | cut -f1))"
  ls -1t "$DEST"/cozybistro-*.tar.gz.age 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
else
  rm -f "$OUT.part"; problem "NO BACKUP: tar | age failed (no unencrypted copy was kept)"
fi

# ---- 4. start, verify, report ----
log "starting database"
finish
