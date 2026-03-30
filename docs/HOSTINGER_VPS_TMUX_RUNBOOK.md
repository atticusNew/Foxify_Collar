# Hostinger VPS tmux Runbook (Docker + IBKR Desktop TWS Tunnel)

This runbook is for your setup:

- VPS host: `root@srv1536090`
- Stack path: `/opt/ibkr-stack`
- Runtime: Docker Compose on VPS
- IBKR session source: **TWS running on your desktop**

---

## 1) One-time VPS setup

Run on VPS:

```bash
ssh root@srv1536090
mkdir -p /opt/ibkr-stack
cd /opt/ibkr-stack
git clone https://github.com/atticusNew/Foxify_Collar.git .
git checkout cursor/platform-pilot-readiness-c44e
cp .env.example .env
```

Install required tools (if missing):

```bash
apt-get update
apt-get install -y tmux curl jq
```

---

## 2) Required `.env` values (desktop TWS connectivity)

Edit `/opt/ibkr-stack/.env` and set at minimum:

```bash
PILOT_API_ENABLED=true
PILOT_VENUE_MODE=ibkr_cme_live
PILOT_HEDGE_POLICY=options_primary_futures_fallback

# API -> broker bridge auth
IBKR_BRIDGE_TOKEN=<LONG_RANDOM_SECRET>
IBKR_BRIDGE_REQUIRE_AUTH=true

# Allow execution when ready (set false for dry run)
IBKR_ENABLE_EXECUTION=true
IBKR_ACCOUNT_ID=<YOUR_IBKR_ACCOUNT_ID>

# Enforce real transport for live pilot integrity
IBKR_REQUIRE_LIVE_TRANSPORT=true

# Bridge transport settings
IBKR_BRIDGE_TRANSPORT=ib_socket
IBKR_BRIDGE_FALLBACK_TO_SYNTHETIC=false
IBKR_BRIDGE_READONLY=false

# Desktop TWS reverse tunnel lands on VPS host port 14002
IBKR_GATEWAY_HOST=host.docker.internal
IBKR_GATEWAY_PORT=14002
IBKR_GATEWAY_CLIENT_ID=101

# Pilot operational controls
USER_HASH_SECRET=<LONG_RANDOM_SECRET>
PILOT_ADMIN_TOKEN=<LONG_RANDOM_SECRET>
PILOT_INTERNAL_TOKEN=<LONG_RANDOM_SECRET>
PILOT_PROOF_TOKEN=<LONG_RANDOM_SECRET>
POSTGRES_URL=postgresql://atticus:<DB_PASSWORD>@postgres:5432/atticus
DB_PASSWORD=<DB_PASSWORD>
```

Notes:

- Use `PILOT_VENUE_MODE=ibkr_cme_paper` for paper rehearsal.
- For paper rehearsal, you can set `IBKR_BRIDGE_FALLBACK_TO_SYNTHETIC=true` while testing connectivity.

---

## 3) Desktop side: keep TWS tunnel up continuously

Your desktop must keep a reverse SSH tunnel to VPS so broker-bridge can reach TWS.

### 3.1 TWS API settings on desktop

- Enable API socket connections in TWS.
- Confirm port:
  - Paper TWS usually `7497`
  - Live TWS usually `7496`

### 3.2 Start persistent tunnel in tmux (desktop)

Use the correct local TWS port (`7497` or `7496`):

```bash
tmux new-session -d -s ibkr-tunnel 'while true; do ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -N -R 0.0.0.0:14002:127.0.0.1:7497 root@srv1536090; sleep 5; done'
```

Check tunnel session:

```bash
tmux ls
tmux attach -t ibkr-tunnel
```

Important:

- `-R 0.0.0.0:14002:...` requires VPS sshd allowing gateway ports.
- On VPS, set `/etc/ssh/sshd_config` with:

```text
GatewayPorts clientspecified
```

Then reload sshd:

```bash
systemctl reload ssh
```

---

## 4) VPS side: start stack in tmux

From VPS:

```bash
ssh root@srv1536090
cd /opt/ibkr-stack
git pull origin cursor/platform-pilot-readiness-c44e
```

Start stack in dedicated tmux session:

```bash
tmux new-session -d -s atticus-stack 'cd /opt/ibkr-stack && docker compose --env-file .env up --build'
```

Optional monitoring tmux session:

```bash
tmux new-session -d -s atticus-watch 'while true; do date -u; curl -s http://127.0.0.1:8000/pilot/health | jq .; echo "---"; sleep 20; done'
```

View sessions:

```bash
tmux ls
```

Attach to stack logs:

```bash
tmux attach -t atticus-stack
```

Detach from tmux without stopping:

- `Ctrl+b` then `d`

---

## 5) Health and readiness checks

On VPS:

```bash
cd /opt/ibkr-stack
docker compose ps
curl -s http://127.0.0.1:8000/health | jq .
curl -s http://127.0.0.1:8000/pilot/health | jq .
```

Expected for live mode:

- `/pilot/health` should show:
  - `checks.venue.transport = "ib_socket"`
  - `checks.venue.activeTransport = "ib_socket"`
  - overall `status = "ok"`

If degraded, inspect:

```bash
docker compose logs --tail=200 broker-bridge
docker compose logs --tail=200 atticus
```

---

## 6) Restart and recovery commands

### Restart only app stack (keep data)

```bash
cd /opt/ibkr-stack
docker compose --env-file .env down
docker compose --env-file .env up --build
```

### Restart specific service

```bash
cd /opt/ibkr-stack
docker compose restart broker-bridge
docker compose restart atticus
```

### If desktop tunnel drops

1. Reattach desktop tmux:
   ```bash
   tmux attach -t ibkr-tunnel
   ```
2. Restart tunnel loop.
3. Recheck VPS `/pilot/health`.

---

## 7) Reboot persistence (VPS)

If VPS reboots, auto-start tmux stack session via root crontab:

```bash
crontab -e
```

Add:

```text
@reboot /usr/bin/tmux new-session -d -s atticus-stack 'cd /opt/ibkr-stack && docker compose --env-file .env up'
@reboot /usr/bin/tmux new-session -d -s atticus-watch 'while true; do date -u; curl -s http://127.0.0.1:8000/pilot/health | /usr/bin/jq .; echo "---"; sleep 20; done'
```

Desktop tunnel should also be configured to auto-start on desktop login/reboot (tmux, systemd user service, or launch agent).

