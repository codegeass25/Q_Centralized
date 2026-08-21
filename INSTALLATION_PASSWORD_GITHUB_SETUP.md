# QLog Pro Ultimate — Installation Password: Complete Owner Setup Guide

This guide is for **you, the system owner/developer**. It explains the Installation
Password, where to put it in GitHub, how to change it, how installers use it, and how
to troubleshoot every common problem.

You do **not** need to write any code. Everything is already implemented.

---

## 1. What is the Installation Password?

The **Installation Password** is a secret that **you** control. A person installing
QLog Pro Ultimate must type it once, on first run, before they are allowed to reach
the Superadmin Setup screen. It is the "licence key" for a device.

* It is created and controlled **only by you**, through a GitHub Actions secret.
* The installer **cannot** create it, change it, reset it, or see it.
* It is **never** stored in plaintext — not in the source code, not in the deployed
  files, not in the browser, not in the UI.
* Verification works **100% offline**, with no server, no API, no internet.

### How it works technically (short version)

During the GitHub Actions production build, the workflow reads your secret,
generates a random salt, and computes an iterated one-way SHA-256 digest
(25,000 rounds). Only the salt and the digest are written into
`install-gate.js` in the deployed build. The app hashes whatever the installer types
and compares digests. The plaintext password is never recoverable from the build.

---

## 2. Installation Password vs Superadmin Password

| | Installation Password | Superadmin Password |
|---|---|---|
| Who controls it | **You** (system owner) | The installer / site admin |
| Where it lives | GitHub Actions secret `QLOG_INSTALLATION_PASSWORD` | Hashed in the device's local storage |
| When it is used | Once, on first run, before setup | Every time the app is opened |
| Can the installer change it | **No** | Yes (Password button in the app) |
| Purpose | Authorises the *installation* | Protects daily *operation* |

They are completely separate. Changing one never affects the other.

---

## 3. Where to set the secret in GitHub (exact navigation)

1. Open your repository on GitHub (the one containing `index.html`).
2. Click the **Settings** tab (top of the repo, right side).
3. In the left sidebar, click **Secrets and variables**.
4. Click **Actions**.
5. Make sure you are on the **Secrets** tab (not "Variables").
6. Click the green **New repository secret** button (top right).
7. Fill in the form:
   * **Name:** `QLOG_INSTALLATION_PASSWORD`  ← must be exactly this, uppercase
   * **Secret:** your private Installation Password (the value installers will type)
8. Click **Add secret**.

```
GitHub Repository
  └── Settings
        └── Secrets and variables
              └── Actions
                    └── Secrets tab
                          └── [New repository secret]
                                Name:   QLOG_INSTALLATION_PASSWORD
                                Secret: <your private installation password>
```

**Screenshot placeholders** (where to look if you are unsure):

* `[SCREENSHOT 1]` — Repo top navigation bar: *Code · Issues · Pull requests · Actions ·
  Projects · Wiki · Security · Insights · **Settings***. Settings is the right-most item.
* `[SCREENSHOT 2]` — Settings left sidebar, under the "Security" group:
  **Secrets and variables** with sub-items *Actions*, *Codespaces*, *Dependabot*.
* `[SCREENSHOT 3]` — The Actions secrets page with two tabs, **Secrets** and *Variables*,
  and the green **New repository secret** button at the top right.
* `[SCREENSHOT 4]` — The "New secret" form with the **Name** field and the multiline
  **Secret** field, and the **Add secret** button at the bottom.

### What value should I enter?

Whatever you want the Installation Password to be. Recommendations:

* At least 12 characters, mixing letters, numbers and symbols.
* Not the same as your Superadmin password or any other account password.
* Store it in your own password manager — GitHub will **never show it to you again**
  after you save it (you can only overwrite it).

### Never do this

* Never type the password into `index.html`, `install-gate.js`, `manifest.json`,
  or any other file in the repository.
* Never paste it into a commit message, issue, pull request, or `README`.
* Never `echo` it in a workflow step.

---

## 4. Changing the Installation Password later

1. Go to **Settings → Secrets and variables → Actions → Secrets**.
2. Find `QLOG_INSTALLATION_PASSWORD` and click the pencil / **Update** button.
3. Enter the new value and click **Update secret**.

**Important:** changing the secret does **not** change anything that is already
deployed or already installed. The verification digest is baked into the build.
You must run a **new production build and deployment** for the new password to
take effect.

### How to trigger a new build

Either:

* **Manual (recommended):** repo → **Actions** tab → in the left sidebar click
  **Build & Deploy QLog Pro Ultimate (GitHub Pages)** → click **Run workflow** →
  choose the branch (`main`) → **Run workflow**.
* **Automatic:** push any commit to `main` / `master`.

Wait for the green check mark on the workflow run, then wait for the `deploy` job to
finish (it prints the live Pages URL).

### How to verify the new build uses the new password

1. Open the deployed site in a **private/incognito window** (no previous activation).
2. Hard-refresh (`Ctrl` + `Shift` + `R`) to bypass the PWA cache.
3. Type the **old** password → must be rejected ("Access denied").
4. Type the **new** password → must be accepted and show Superadmin Setup.
5. Optional technical check: open `https://<your-site>/install-gate.js` in the browser.
   The `s` (salt) and `h` (hash) values must be different from the previous build,
   and `built` must show the new build timestamp.

---

## 5. How an installer uses the password

### Complete first-install workflow

1. You give the installer the Installation Password through a secure channel
   (phone call, password manager share, sealed note — not public chat).
2. The installer opens / installs the QLog Pro Ultimate PWA.
3. The **Installation Password** screen appears first.
4. The installer types the password (masked) and clicks **Activate This Device**.
5. On success, the device is marked activated and the existing
   **Superadmin Setup** screen appears.
6. The installer creates their **own** Superadmin password (min. 6 characters).
7. QLog Pro starts normally.

### If the wrong password is entered

* The message **"Access denied. Incorrect Installation Password."** appears.
* The field is cleared.
* Superadmin Setup stays hidden and unreachable — refreshing, navigating, or
  calling the setup function directly re-triggers the gate.
* There is no limit on retries, but nothing is unlocked without the correct value.

### After successful verification

* An activation record is written to the device's local storage
  (a flag plus a non-reversible build fingerprint — **not** the password).
* Superadmin Setup opens immediately.

### Already-activated devices

* On every later launch, the Installation Password screen is **skipped** entirely.
* The device goes straight to the normal Superadmin login.

### Resetting browser/app storage

Clearing site data, uninstalling the PWA and reinstalling, using a different browser,
or using a different user profile **erases the activation record**. The device is then
treated as a fresh install and the Installation Password is required again.
Clearing storage also erases the Superadmin password and local QLog data —
always export/back up data first.

---

## 6. Troubleshooting

**"Secret not found" / workflow error: `QLOG_INSTALLATION_PASSWORD is missing`**
The secret name is misspelled or was added in the wrong place. It must be a
**repository secret under Actions**, named exactly `QLOG_INSTALLATION_PASSWORD`
(uppercase, underscores). Environment secrets and Dependabot secrets do not apply.
If the repo is a fork, secrets are not inherited — add them to the fork.

**Workflow failure**
Open **Actions → the failed run → the red step**. Common causes:
* Missing secret (see above).
* GitHub Pages not enabled: **Settings → Pages → Build and deployment → Source:
  GitHub Actions**.
* The "Verify no plaintext password leaked" step failed — the password string was
  found inside the build. Remove it from any source file and rebuild.

**Installation Password rejected even though it is correct**
* You changed the secret but did not rebuild/redeploy — run the workflow again.
* The device is loading an old cached build — hard-refresh (`Ctrl`+`Shift`+`R`)
  or uninstall/reinstall the PWA.
* Leading/trailing spaces were copied into the GitHub secret box, or the value was
  pasted with a newline. Re-enter the secret carefully.

**Old password still working**
The device is still running the previously cached build, or it is already activated
(activated devices never prompt again). Clear site data / reinstall the PWA to test.

**New password not working**
The deployment has not finished, or the browser is serving the cached
`install-gate.js`. Check the workflow run is green, then hard-refresh.

**GitHub Actions build not triggered**
* Actions may be disabled: **Settings → Actions → General → Allow all actions**.
* The push went to a branch other than `main`/`master`.
* Use **Actions → Run workflow** to trigger it manually.

**PWA showing an old cached version**
The service worker cache version was bumped (`qlogpro-offline-v9`), so a normal
reload while online usually updates it. If not: close all app windows and reopen, or
hard-refresh, or uninstall and reinstall the PWA. In the browser you can also use
DevTools → Application → Service Workers → *Unregister*, then reload.

---

## 7. Verifying the secret is never exposed

1. **In the repository:** search the repo (press `/` on GitHub, or run
   `git grep -i "<your password>"` locally). There must be zero results.
   The committed `install-gate.js` must contain only `__QLOG_GATE_SALT__` /
   `__QLOG_GATE_HASH__` placeholders.
2. **In the deployed build:** open `https://<your-site>/install-gate.js` — you should
   see only a random salt, a hash, an iteration count and a build timestamp.
3. **In the workflow logs:** **Actions → latest run → each step**. GitHub masks
   registered secrets as `***`, and no step in this workflow echoes the value. Search
   the log (`Ctrl`+`F`) for the password — there must be no match.
4. The workflow itself contains an automatic guard step that fails the build if the
   plaintext password is ever found inside the deployed output.

---

## 8. Security limitation (please read)

QLog Pro Ultimate is a fully offline, client-side PWA. A client-side installation gate
is a **deterrent and licensing control**, not server-grade authentication. Anyone with
enough technical skill and full access to a device can inspect the deployed files or
local storage and bypass a purely client-side check, and could attempt to brute-force
the digest offline. What this implementation guarantees is that the **plaintext
password is never exposed** in the source, the build, the UI, the logs, or the
browser — and that a normal installer cannot reach Superadmin Setup without it.
For true enforcement you would need a server-side licence check, which would break
the offline requirement.

Choose a long, high-entropy Installation Password to make offline brute-forcing
impractical.

---

## BEFORE DISTRIBUTING QLOG TO AN INSTALLER

- [ ] **Installation Password configured** — I have chosen a strong password and saved
      it in my own password manager.
- [ ] **GitHub Secret exists** — `QLOG_INSTALLATION_PASSWORD` is listed under
      Settings → Secrets and variables → Actions → Secrets.
- [ ] **Production build completed** — the "Build & Deploy QLog Pro Ultimate" workflow
      finished with a green check.
- [ ] **Deployment completed** — the `deploy` job succeeded and the Pages URL loads.
- [ ] **New build tested** — opened in a private window / fresh profile.
- [ ] **Installation Password verified** — correct password is accepted, wrong password
      is denied.
- [ ] **Superadmin Setup verified** — setup appears only after activation and a new
      Superadmin password can be created.
- [ ] **Offline mode tested** — installed the PWA, disconnected the internet, relaunched;
      the app and the gate behave correctly.
- [ ] **Plaintext password not committed** — repository search returns no match.
- [ ] **GitHub Actions logs checked** — no step prints the secret; search of the log
      returns no match.
