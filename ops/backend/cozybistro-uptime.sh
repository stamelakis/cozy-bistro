#!/usr/bin/env bash
# Every-5-minute health check of Cozy Bistro's database. On the box at
# /opt/cozybistro-uptime.sh, run by /etc/cron.d/cozybistro-uptime. Asks
# https://db.cozy-bistro.com/v1/ping through the local Caddy, so TLS, the
# vhost and the database are all checked. On failure it restarts the
# container and checks again. Mail goes to the owner through
# /opt/owner-mail.py, one per incident (same shape as webstudio's and amelie's):
#   - down and the restart fixed it -> one mail «έπεσε και επανήλθε» (cap 4/day)
#   - still down after the restart  -> one mail, a reminder every 6 h, one «λειτουργεί ξανά»
# Install this cron only AFTER the Caddy block is live, or it alerts at once.
# It stays quiet while the nightly job holds its lock (the planned 10 s stop).
set -uo pipefail
HOST=${HOST:-db.cozy-bistro.com}
APP=${APP:-cozybistro-stdb}
OWNER_MAIL=${OWNER_MAIL:-/opt/owner-mail.py}
STATE_DIR=${STATE_DIR:-/var/lib/owner-mail}
NIGHTLY_LOCK=${NIGHTLY_LOCK:-/opt/backups/.cozybistro-nightly.lock}
DOWN="$STATE_DIR/cozybistro.down"   # line 1: down since (Athens time), line 2: last alert sent (epoch, 0 = none yet)
REMIND=$((6 * 3600))

health(){ local c; c=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 15 --resolve "$HOST:443:127.0.0.1" "https://$HOST/v1/ping" 2>/dev/null); echo "${c:-000}"; }
when(){ TZ=Europe/Athens date '+%d/%m/%Y %H:%M'; }
mail(){ # tag cap subject body -> owner-mail's exit code
  printf '%s\n' "$4" | timeout 120 "$OWNER_MAIL" --tag "$1" --cap "$2" --name "Cozy Bistro · Server" --subject "$3" >/dev/null
  local rc=$?
  [ $rc = 0 ] || echo "$(date -Is) alert not sent (owner-mail exit $rc, see /var/log/owner-mail.log)"
  return $rc
}
mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"

# the nightly job is in its planned stop: not an incident
if [ -e "$NIGHTLY_LOCK" ] && command -v flock >/dev/null 2>&1; then
  flock -n "$NIGHTLY_LOCK" true || exit 0
fi

S=$(health)
if [ "$S" = "200" ]; then
  if [ -f "$DOWN" ]; then
    since=$(sed -n 1p "$DOWN")
    echo "$(date -Is) RECOVERED (down since $since)"
    mail cozybistro-uptime 12 "✅ Cozy Bistro: το παιχνίδι λειτουργεί ξανά" "Η βάση του Cozy Bistro ($HOST) λειτουργεί ξανά.
Εκτός λειτουργίας από: $since
Επανήλθε: $(when)" && rm -f "$DOWN"
  fi
  exit 0
fi

echo "$(date -Is) DOWN: $HOST=$S -> restarting $APP"
docker restart "$APP" >/dev/null 2>&1
sleep 20
S2=$(health)
echo "$(date -Is) after restart: $HOST=$S2"

if [ "$S2" = "200" ]; then
  if [ -f "$DOWN" ]; then
    since=$(sed -n 1p "$DOWN")
    mail cozybistro-uptime 12 "✅ Cozy Bistro: το παιχνίδι λειτουργεί ξανά" "Η βάση του Cozy Bistro ($HOST) λειτουργεί ξανά (μετά από αυτόματη επανεκκίνηση).
Εκτός λειτουργίας από: $since
Επανήλθε: $(when)" && rm -f "$DOWN"
  else
    mail cozybistro-uptime-flap 4 "🟠 Cozy Bistro: η βάση έπεσε και επανήλθε" "Η βάση του Cozy Bistro ($HOST) δεν απαντούσε (κωδικός $S) και επανήλθε με αυτόματη επανεκκίνηση.
Ώρα: $(when)
Δεν χρειάζεται κάτι· αν ξανασυμβεί συχνά, δες: docker logs $APP --since 1h"
  fi
  exit 0
fi

now=$(date +%s)
if [ ! -f "$DOWN" ]; then
  since=$(when); last=0
else
  since=$(sed -n 1p "$DOWN"); last=$(sed -n 2p "$DOWN")
  [[ "$last" =~ ^[0-9]+$ ]] || last=0
fi
if [ "$last" = 0 ]; then
  subject="🔴 Cozy Bistro: το παιχνίδι είναι εκτός λειτουργίας"
  body="Η βάση του Cozy Bistro ($HOST) δεν απαντά (κωδικός $S, και $S2 μετά από αυτόματη επανεκκίνηση).
Από: $since
Θα λάβεις υπενθύμιση κάθε 6 ώρες όσο διαρκεί, και ένα μήνυμα όταν επανέλθει.
Πρώτος έλεγχος: docker logs $APP --since 1h  και  df -h /opt/cozy-bistro/data (αν είναι 100%, γέμισε ο χώρος της βάσης)"
elif [ $((now - last)) -ge $REMIND ]; then
  subject="🔴 Cozy Bistro: το παιχνίδι είναι ακόμα εκτός λειτουργίας"
  body="Η βάση του Cozy Bistro ($HOST) εξακολουθεί να μην απαντά (κωδικός $S2).
Εκτός λειτουργίας από: $since"
else
  exit 0
fi
if mail cozybistro-uptime 12 "$subject" "$body"; then last=$now; fi
printf '%s\n%s\n' "$since" "$last" > "$DOWN"
exit 0
