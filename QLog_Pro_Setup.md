# QLog Pro Ultimate — Setup

Drop `UI_QLog_Pro_Ultimate.html` into the same folder as your existing app so it can reach `libs/` and `manifest.json`. Two new pieces are needed for the AI face-recognition upgrade:

## 1. face-api.js library (offline)

Download the minified build and save it as:

```
libs/face-api.min.js
```

Recommended build (works offline, weights are separate):
- https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/dist/face-api.min.js

(If `libs/face-api.min.js` is missing at load time, the page auto-falls back to that CDN URL. Placing it locally is what makes the app fully offline.)

## 2. Face recognition model weights

Create a `models/` folder next to the HTML and put these files inside it (download from https://github.com/vladmandic/face-api/tree/master/model — or the equivalent `justadudewhohacks/face-api.js` `weights` folder):

```
models/
  tiny_face_detector_model-weights_manifest.json
  tiny_face_detector_model-shard1
  face_landmark_68_model-weights_manifest.json
  face_landmark_68_model-shard1
  face_recognition_model-weights_manifest.json
  face_recognition_model-shard1
  face_recognition_model-shard2
```

Total is roughly 6 MB. Once these files exist, the app runs face recognition fully offline.

## Everything else

All original features (QR/USB/camera scanning, visitor logging, client inventory, book inventory, borrowing/returns, reservations queue, reports, Excel + PDF export/import, audit trail, localStorage database, live monitoring dashboard) are preserved and continue to function exactly as before.

---

## Offline-First (v3) — What Changed

QLog Pro Ultimate now runs **100% offline** once installed and cached one time while online.

**Zero external runtime dependencies.** Removed: Google Fonts (`fonts.googleapis.com`,
`fonts.gstatic.com`), the face-api jsDelivr script fallback, the jsDelivr face-model URL, and the
cdnjs `qrcode.min.js` inside the exported Client Inventory HTML.

* `fonts/` — Inter + JetBrains Mono (woff2, latin + latin-ext) bundled locally via `fonts/fonts.css`.
* `libs/` — xlsx, qrcode, jsQR, html2pdf, face-api all loaded from `./libs/...` only.
* `models/` — all 7 face-api models (manifest + .bin) load from `./models` only.
* face-api picks a WebGL backend, falling back to the pure-JS CPU backend, so no `.wasm` is fetched.
* Exported Client Inventory HTML now embeds QR codes as inline PNG data URLs — the exported file
  works offline forever with no script tag.
* `service-worker.js` — rebuilt: single `CACHE_NAME = "qlogpro-offline-v3"`, precaches all 39 app
  resources, cache-first for assets, network-first navigations with an `index.html` app-shell
  fallback, old caches purged on activate. **localStorage is never touched by updates.**
* All paths are relative (`./...`) — safe for GitHub Pages project subpaths.
* Online/Offline pill (bottom right). "OFFLINE MODE" is a normal supported state.

### Offline self-test

Open the console and run `qlogOfflineDiagnostic()` (or double-click the status pill).
It reports PASS/FAIL for the service worker, cache storage, app shell, each local library,
each face model, localStorage, camera API, offline navigation and external dependencies.

### Verified

Loaded online → SW installed → 39 resources cached → network disabled → reloaded:
app shell, fonts, superadmin setup/login, all libraries, face model loading (tiny detector,
landmark 68, recognition), QR data-URL generation, XLSX export, PDF export and the diagnostic
all pass with **0 external network requests**.

---

## Equipment Borrowing Module (Offices / Laboratories / Departments / Units)

- New tab: **🧰 Equipment Borrowing**, visible only to authorized units.
- **Hidden automatically** for Library personnel (librarian role or any Library-related
  facility/designation) and for Security/Guard personnel (detected from facility,
  in-charge, designation, office, department, unit or assignment text using keywords such as
  Guard, Guards, Guard House, Guard Post, Security, Security Office, Security Guard,
  Watchman, Sentry, Gatekeeper).
- **Equipment Registry**: register equipment ID/QR, name, category, assigned unit and
  condition; print per-item QR codes (offline); mark items Available / Maintenance / Damaged;
  export the registry to .xlsx. Items can only be edited by their assigned unit.
- **Borrowing**: scan the borrower QR (must exist in the client database — unregistered
  borrowers are rejected), then scan or select the equipment QR. The system verifies the
  assigned unit and availability, blocks duplicate/unavailable borrowing, and records
  expected return, condition on release, purpose and the releasing in-charge.
- **Returns**: records actual return date/time, condition (Good/Fair/Damaged/For Maintenance)
  and remarks; equipment status updates automatically to Available, Damaged or Maintenance.
- **Status tracking**: Available, Borrowed, Returned, Overdue, Damaged, Maintenance. Overdue is
  computed automatically on load and every minute.
- **History & reports**: per-equipment history, per-borrower equipment history, status/date/text
  filters, .xlsx export and printable report with the standard signature block.
- Data is stored offline in localStorage keys `equipment` and `equipLogs` and is precached by
  service worker cache `qlogpro-offline-v7`.
