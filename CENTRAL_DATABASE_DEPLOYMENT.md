# QLog Pro Ultimate — Central Database Deployment

## Architecture

`qlogproult.mdmsportal.uk` is the GitHub Pages PWA. It continues to use localStorage as its offline cache.

`qlog-api.mdmsportal.uk` is the Cloudflare Tunnel hostname for the Node.js backend. The backend stores synchronized records in one SQLite3 file and broadcasts updates with Socket.IO.

`/central.html` is the protected central reporting page hosted by the backend.

## Backend files

- `backend/server.js` — Express + Socket.IO API
- `backend/package.json` — Node dependencies
- `backend/.env.example` — production environment template
- `backend/data/qlog-pro.sqlite3` — created automatically on first run
- `backend/start-windows.bat` — Windows launcher
- `backend/start-linux.sh` — Linux launcher

## Windows deployment

Open a terminal in `backend/`:

```powershell
Copy-Item .env.example .env
notepad .env
npm install
node server.js
```

Set at minimum:

```text
OFFICE_ACCESS_CODE=<strong-random-office-code>
REPORT_ADMIN_PASSWORD=<strong-random-report-password>
CORS_ORIGIN=https://qlogproult.mdmsportal.uk
PUBLIC_API_URL=https://qlog-api.mdmsportal.uk
```

Do not put the Office Access Code or Report Admin Password into GitHub Pages source code.

## Cloudflare Tunnel `pickleball-api`

The backend origin is:

```text
http://127.0.0.1:8787
```

Ingress template:

```yaml
tunnel: pickleball-api
credentials-file: C:\Users\YOUR-WINDOWS-USER\.cloudflared\<TUNNEL-UUID>.json

ingress:
  - hostname: qlog-api.mdmsportal.uk
    service: http://127.0.0.1:8787
  - service: http_status:404
```

The frontend remains the GitHub Pages custom domain:

```text
https://qlogproult.mdmsportal.uk
```

The two hostnames therefore have distinct responsibilities rather than competing for the same origin.

## First-run validation

1. Open `https://qlog-api.mdmsportal.uk/api/health` and confirm JSON reports `"ok": true` and `"db": "sqlite3"`.
2. Open `https://qlogproult.mdmsportal.uk/` and complete the existing QLog Pro session setup.
3. Enter the Office Access Code when the Central Database dialog appears.
4. Perform a test time-in / time-out log and a visitor log with the existing camera workflow.
5. Open `https://qlog-api.mdmsportal.uk/central.html`, sign in with the Report Admin Password, and verify the records appear.
6. Leave Central Reports open and perform another test log. The page should update from the Socket.IO event without a manual browser refresh.
7. Use **Export All Visitor Logs (.html)** to generate a self-contained HTML file containing the centrally stored visitor images that were part of the synced visitor records.

## Data safety

The backend uses SQLite WAL mode. The database file is local to the machine running Node.js, so include `backend/data/qlog-pro.sqlite3` and its WAL/SHM files in your normal server backup policy while the service is running. Do not commit the database to Git.

## Hardened synchronization (v2)

The central sync layer now uses stable content fingerprints, per-record revisions, tombstones for deletions, idempotent upserts, and a per-device `/api/reconcile` pull path. This means repeated sync retries do not create duplicate rows and deleted rows are not resurrected by stale clients.

Books and equipment use inventory-aware fingerprints that retain physical-copy identifiers such as accession/asset/serial numbers. Exact repeated imports on the same office/device are collapsed locally before upload and are also deduplicated server-side through `sync_aliases`.

The old database schema is upgraded automatically on backend startup. Existing `books` and `equipment` rows receive fingerprints and exact duplicate rows are collapsed into aliases without deleting the canonical copy.

Central reports ignore tombstoned rows. Socket.IO still broadcasts `qlog:updated` for live central dashboards, while clients periodically call `/api/reconcile` so the office cache can recover from central-side corrections or database restoration without a manual refresh.
