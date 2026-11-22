# Cozy Bistro's database on our own server

Since November 2026 the game's SpacetimeDB runs on Andreas's shared Hetzner box
(`ssh -i ~/.ssh/hetzner root@178.104.158.125`), next to the education site,
TakeaSeat, amelie and webstudio. Box rules: `C:/Users/andre/servers/SERVER.md`
and the education repo's `ops/BOX.md`. **Touch only what is listed here.**

| What | Where on the box |
|---|---|
| Folder | `/opt/cozy-bistro` (compose file, `data.img`, `data/`) |
| Container | `cozybistro-stdb` (image `cozybistro-stdb:2.3.0`, built on the PC) |
| Network | `cozybistro_net` (the shared Caddy `edu-admin-caddy-1` is connected to it) |
| Data | `/opt/cozy-bistro/data`, a fixed 8 GB filesystem inside `data.img` |
| Players' address | `wss://db.cozy-bistro.com` (block in `/opt/edu-admin/Caddyfile`, text in `caddy-block.txt`) |
| Admin address | `127.0.0.1:3100` on the box only (use an SSH tunnel) |
| Nightly job | `/opt/cozybistro-nightly.sh`, `/etc/cron.d/cozybistro-nightly`, 03:30 UTC |
| Uptime check | `/opt/cozybistro-uptime.sh`, `/etc/cron.d/cozybistro-uptime`, every 5 min |
| Backups | `/opt/backups/cozybistro-*.tar.gz.age` (7 kept, pushed off-site at 03:40) |
| Backup key | public half `/opt/cozybistro-backup.pub`; private half only in Andreas's password manager |
| Logs | `/var/log/cozybistro-nightly.log`, `/var/log/cozybistro-uptime.log` |

Databases on the server: `dunnin` (live game) and `dunnin-staging`.

## Why it is built this way (read before changing anything)

- **The commit log only grows.** SpacetimeDB writes every change to a log and
  never deletes old pieces. The game's ticks write about 3 changes a second,
  all day, even with nobody online. This filled the previous host's disk and
  ended with the database deleted. Measured here (v2.3.0, one empty
  restaurant): about 36 MB a day idle, about 174 MB a day per connected
  player, before compression.
- **So the nightly job prunes.** The server takes a snapshot whenever a log
  piece is full (64 MiB, `max-segment-size` in `data/config.toml`) and
  compresses finished pieces to about a fifth. With the server stopped, the
  nightly job deletes everything older than the second-newest snapshot.
  Proven by test: restart, data and new writes are all fine afterwards.
- **So the data has a hard cap.** `data.img` is an 8 GB filesystem in a file.
  If pruning ever fails and the data fills it, the *game* stops with a full
  disk and the uptime check mails Andreas. The box and the other sites are
  not affected.
- **The signing keys live in `data/keys`.** Every player's saved login is
  signed with them. Lose them and every player loses their restaurant. They
  are on the data volume and in every backup. Never start the server without
  the `--jwt-*-key-path` options (they are in the Dockerfile).
- **Caddy lets through four paths only** (`caddy-block.txt` says why). The
  rest of SpacetimeDB's API would let strangers publish their own databases
  on our server.
- **Pruning works on Linux only.** On Windows the server cannot save
  snapshots, so never test pruning with a Windows server.
- **Never prune a database that is not healthy.** When the disk fills, the
  server stops itself and leaves a half-written log tail plus snapshots that
  are *ahead* of the log. A prune that trusts those deletes the only good
  history. In the lab this lost the whole test database. So the nightly job
  (a) does nothing unless the database answers first, and (b) counts a
  snapshot only when a later log piece exists. Keep both rules.
- **The admin is whoever owns the username `dunnin`** (`ADMIN_USERNAME` in
  `v2/spacetime/src/reducers/auth.rs`). On a fresh database Andreas must sign
  up that name before the public site points at the server.

## What was tested (2026-11-22, locally in Docker, v2.3.0)

| Test | Result |
|---|---|
| Slim image starts, creates keys in `data/keys` | passed |
| Game sign-up and play through the Caddy block | passed |
| Caddy block: publish, SQL, logs, other databases | all refused (404) |
| Nightly job: 15 old log pieces removed, data and logins intact | passed |
| Nightly job when the database is down | does nothing, reports, exits 1 |
| Restore of the encrypted backup into an empty server | data and old logins work |
| Container deleted and recreated | old logins still work |
| Data space full | server stops itself; nothing else affected |
| Recovery from full by enlarging (steps below) | data intact, writes resume |

Not tested yet (needs the real box): the 8 GB cap on the box itself, the
real Caddy with TLS, the owner mails, growth with real players.

## Everyday tasks

Open the tunnel first (leave the window open while you work):

```
ssh -i ~/.ssh/hetzner -N -L 3100:127.0.0.1:3100 root@178.104.158.125
```

One-time on the PC: `spacetime server add cozybox --url http://127.0.0.1:3100 --no-fingerprint`

- **Publish the module** (from `v2/spacetime`):
  `spacetime publish --server cozybox -p . dunnin --yes` and the same with
  `dunnin-staging`. A change that would wipe data makes the CLI ask; do not
  pass `--delete-data` on the live database without Andreas's OK.
- **Server logs of the module:** `spacetime logs --server cozybox dunnin -n 100`
- **Is it up:** `curl -s -o /dev/null -w '%{http_code}' https://db.cozy-bistro.com/v1/ping` gives `200`.
- **How full is the data space** (on the box): `df -h /opt/cozy-bistro/data`
  and `du -sh /opt/cozy-bistro/data/replicas/*/clog`
- **Run the nightly job by hand** (on the box, about 10 s of downtime):
  `/opt/cozybistro-nightly.sh`

## First install (one time; every step needs Andreas's OK)

1. DNS at Papaki: `A` record `db.cozy-bistro.com` to `178.104.158.125`.
2. On the PC: `docker build -t cozybistro-stdb:2.3.0 ops/backend` then
   `docker save cozybistro-stdb:2.3.0 | gzip | ssh -i ~/.ssh/hetzner root@178.104.158.125 "gunzip | docker load"`
3. Copy `docker-compose.yml` and `setup-box.sh` to `/opt/cozy-bistro/`, the two
   scripts to `/opt/`, then run `bash /opt/cozy-bistro/setup-box.sh`.
4. Backup key: `age-keygen` on the PC; the public line goes to
   `/opt/cozybistro-backup.pub`, the private key to the password manager.
5. Caddy (another project's files, by the procedure in `caddy-block.txt`):
   `docker network connect cozybistro_net edu-admin-caddy-1`, declare the
   network in the education compose, add the block, validate, reload, check
   every site answers.
6. Publish `dunnin` and `dunnin-staging`, then call the bootstrap reducers
   (`bootstrap_world_events`, `bootstrap_season_stamps`). Andreas signs up
   the username `dunnin` on both (local build with
   `CB_HOST=wss://db.cozy-bistro.com`) BEFORE the client change is pushed.
   Prove the cap once: fill a throwaway 64 MB image the same way and see
   `df -h /` unchanged.
7. Install the two files of `cron.d/` into `/etc/cron.d/` (root, 0644).
8. Off-site: add `"$SRC"/cozybistro-*.age` to the loop list in
   `/opt/offsite-push.sh` (another project's file; same way webstudio did it).

## Restore from a backup

Loses everything played since that backup (at most one day).

```
docker stop cozybistro-stdb
mv /opt/cozy-bistro/data/replicas /opt/cozy-bistro/data/replicas.broken   # keep until the restore is confirmed
age -d -i <private key file> /opt/backups/cozybistro-<stamp>.tar.gz.age | tar -C /opt/cozy-bistro/data -xzf -
chown -R 1000:1000 /opt/cozy-bistro/data
docker start cozybistro-stdb
```

Then check the game loads with an existing account, and delete
`replicas.broken`. The private key file must not stay on the box: delete it
after the restore.

## If the data space is full

The game is down and `df -h /opt/cozy-bistro/data` shows 100%. **Do not run
the nightly job and do not delete log files by hand.** Enlarge instead
(tested in the lab). Ask Andreas first, and check `df -h /` has the room.

```
docker stop cozybistro-stdb
umount /opt/cozy-bistro/data
cp --sparse=always /opt/cozy-bistro/data.img /opt/cozy-bistro/data.img.before-fix
truncate -s 12G /opt/cozy-bistro/data.img
e2fsck -fy /opt/cozy-bistro/data.img
resize2fs /opt/cozy-bistro/data.img
mount /opt/cozy-bistro/data
```

Then, in each `/opt/cozy-bistro/data/replicas/<n>/`: move every snapshot whose
number is higher than the newest file in `clog/` into a new folder
`snapshots.aside/` (those are ahead of the log). Then `docker start
cozybistro-stdb`; `docker logs cozybistro-stdb` must say "restored from
snapshot", and the game must load with an existing account. Find out why it
filled (`/var/log/cozybistro-nightly.log`) before anything else. When all is
confirmed, delete `snapshots.aside` and `data.img.before-fix`.

## Updating SpacetimeDB

Change `STDB_VERSION` in the Dockerfile and the image tag in the compose file,
build, test locally against a copy of a backup first (the module is built
against crate 1.12; the client SDK is 2.3.0), then ship as in "First install"
step 2 and `docker compose up -d`. Run the nightly job by hand once after an
update and check its log: pruning depends on the server's file layout.
