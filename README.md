# QLog Pro Ultimate

Offline-first PWA for facility / library logging, with local face recognition,
PP-OCR text extraction, QR scanning, reports and exports. No backend, no CDN,
no internet required after installation.

## Contents

| Path | Purpose |
|---|---|
| `index.html` | The entire application shell and logic |
| `install-gate.js` | Installation Password verification data (**generated at build time**) |
| `service-worker.js` | Offline precache + app shell fallback |
| `manifest.json`, `icons/` | PWA install metadata |
| `libs/`, `models/`, `fonts/` | Bundled offline dependencies |
| `scripts/generate-install-gate.mjs` | Build script that derives the installation verifier |
| `.github/workflows/deploy.yml` | Production build + GitHub Pages deployment |
| `QLog_Pro_Setup.md` | End-user setup notes |

## Two separate passwords

1. **Installation Password** — controlled by the system owner via the GitHub Actions
   secret `QLOG_INSTALLATION_PASSWORD`. Required once, on first run, before Superadmin
   Setup. Installers cannot create, change or reset it.
2. **Superadmin Password** — created by the installer after activation, used for daily
   access and changeable from inside the app.

> **Owners/admins: read [`INSTALLATION_PASSWORD_GITHUB_SETUP.md`](./INSTALLATION_PASSWORD_GITHUB_SETUP.md)**
> for the complete step-by-step guide to configuring the GitHub secret, rebuilding after
> a password change, verifying deployments, troubleshooting, and the pre-distribution
> checklist.

## Building / deploying

Push to `main` (or run the workflow manually from the **Actions** tab). The workflow
assembles the site, generates `install-gate.js` from the repository secret, verifies the
plaintext password never appears in the output, and deploys to GitHub Pages.

Local preview (the installation gate is skipped because no verifier is compiled in):

```bash
python3 -m http.server 8000
```

## Centralized SQLite3 + Socket.IO deployment

This build now includes a complete central backend under `backend/`.

- Frontend: `https://qlogproult.mdmsportal.uk/` (GitHub Pages / PWA)
- Central API: `https://qlog-api.mdmsportal.uk/` (Cloudflare Tunnel -> local Node backend)
- Central reports: `https://qlog-api.mdmsportal.uk/central.html`
- Database: `backend/data/qlog-pro.sqlite3` (SQLite3, WAL mode)
- Real-time: Socket.IO broadcasts central-report updates after device sync.
- Visitor images: visitor face/captured images already held by the app are included in the central sync payload and central visitor export. The valid-ID capture image remains intentionally temporary and is not stored.
- Offline behavior: the existing localStorage cache remains available; central sync resumes automatically when the API is reachable.

### Backend deployment

1. Copy `backend/.env.example` to `backend/.env`.
2. Set unique production values for `OFFICE_ACCESS_CODE` and `REPORT_ADMIN_PASSWORD`.
3. Run `npm install` inside `backend/`.
4. Run `node server.js`, or use `backend/start-windows.bat` on Windows.
5. Keep the backend listening on `127.0.0.1:8787` unless you specifically need another bind address.

### Cloudflare Tunnel

The GitHub Pages hostname and the API hostname should remain separate:

- `qlogproult.mdmsportal.uk` -> GitHub Pages custom domain.
- `qlog-api.mdmsportal.uk` -> existing Cloudflare Tunnel `pickleball-api` -> `http://127.0.0.1:8787`.

Use `cloudflared/config.yml.example` as the ingress template. Do not replace a working GitHub Pages custom-domain DNS record with a tunnel origin unless you intentionally want Cloudflare Tunnel to proxy the frontend too.

Typical API route command (only if it is not already routed):

```bash
cloudflared tunnel route dns pickleball-api qlog-api.mdmsportal.uk
```

Then run the existing tunnel:

```bash
cloudflared tunnel run pickleball-api
```

### First device connection

The first time QLog Pro opens after this deployment, it asks for the Office Access Code. The code is used to obtain a device token and is not stored. After connection, changes to people, logs, books, borrowing, reservations, audit logs, equipment and related configuration are synchronized automatically; no manual refresh button is required.

### Central reports

Open `https://qlog-api.mdmsportal.uk/central.html`, enter the Report Admin Password, and leave the page open. Connected office devices emit Socket.IO update events; the Overview, Live Attendance, Visitors and Office Devices panels refresh automatically.
