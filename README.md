<p align="center"><img src="web/public/logo.svg" alt="simpleIPAM" width="96" /></p>

# simpleIPAM

A lightweight IPAM for home use. Hierarchy: **tenant** (family, company…) → **location** (home1, lab2, cloud-aws…) → **network** (CIDR, VLAN, gateway, DHCP, DNS) → **entries** (IP, FQDN, MAC, type, status, tags).

- address map of each network, "next free IP" (skips the gateway and the DHCP pool)
- inline editing in the table, global search `⌘/Ctrl+K`, light/dark theme
- **interface in Polish, English and German** (switch in the profile menu or on the sign-in screen; the browser language is used by default)
- ping scan, CSV import/export, audit log
- sign-in and registration, **Admin / Contributor / Reader / None** roles granted globally, per tenant or per location; sign in with Google
- conflict detection (duplicate MAC/FQDN, entries inside the DHCP pool, overlapping networks), entries that expire ("valid until"), a growth forecast per network, hosts / dnsmasq / BIND export
- per-entry change history and MAC change detection
- UniFi integration (Site Manager): networks, devices, clients, two-way aliases
- administrator panel (users, backups, settings, audit log)
- backups: download, restore from the UI (with a preview and a safety backup), a daily local backup, optional encryption, and upload to **AWS S3** (and compatible: MinIO, R2, Backblaze), **Google Cloud Storage** or **Google Drive** (one-click sign-in)
- API tokens (Bearer), OpenAPI documentation, bulk edit and sorting, free-subnet finder, periodic scan with a list of new devices and "last seen"
- one container, built-in SQLite database (`/data/ipam.db`), zero npm dependencies in the backend

## Running

```sh
docker compose up -d          # http://localhost:8080
# or
docker run -d -p 8080:8080 -v ipam-data:/data ghcr.io/lukaszsedek/simpleipam:latest
```

The app has no default account. On first start it shows the **"Create administrator account"** screen — the first account always gets the global Admin role. Do this right after starting: whoever opens a fresh instance first becomes the admin, so do not expose it publicly before configuring it.
Every later registration creates an account with the **None** role (no access to anything); an administrator sees such people in *Administration → Users* (a "no permissions" marker and a counter on the Administration button) and grants them roles.
The ping scan has to run on the network it scans (`network_mode: host` for a LAN).

## Docker image and GitHub Actions

On every push to `main` and every version tag the workflow `.github/workflows/ci.yml`:

1. runs the tests (`npm test`); for a tag it also checks that the version in `package.json` and `CHANGELOG.md` matches the tag,
2. builds the image, **runs it** and checks it (`/api/health`, home page, version, registration of the first admin),
3. builds a multi-architecture image (`linux/amd64` and `linux/arm64`, e.g. Raspberry Pi) and pushes it to the **GitHub Container Registry**: `ghcr.io/lukaszsedek/simpleipam`,
4. for a tag, creates a **GitHub Release** with the notes from `CHANGELOG.md`.

Pull requests only build and test; nothing is published.

## Versioning

The project uses [SemVer](https://semver.org/) (`MAJOR.MINOR.PATCH`, e.g. `0.1.0`; before `1.0.0` incompatible changes may land in `MINOR`). The source of truth is the version in `server/package.json` (identical in `web/package.json`), and every release is a git tag `vX.Y.Z`. The current version is shown in the app (sidebar, Administration → Settings).

| Image tag | Meaning |
|---|---|
| `0.1.0` | exactly this release (immutable) |
| `0.1` | the latest patch of the `0.1.x` line |
| `1` | the latest `1.x.y` (from `1.0.0` only) |
| `latest` | the newest **stable** release (no prereleases) |
| `edge` | current `main` (may be unstable) |
| `sha-<hash>` | a specific commit |

For production pin a specific version (`…:0.1.0`) or a line (`…:0.1`) instead of `latest`.

### How to cut a release

1. Describe the changes in `CHANGELOG.md` under `## [Unreleased]`.
2. Run (from a clean `main`):
   ```sh
   node scripts/release.mjs minor            # or patch / major / an exact version, e.g. 1.0.0-rc.1
   node scripts/release.mjs minor --dry-run  # only show what would happen
   ```
   The script runs the tests, bumps the version in `server/` and `web/`, turns `[Unreleased]` into a dated heading, makes the commit `Release vX.Y.Z` and the tag. It pushes nothing.
3. Push: `git push origin main --follow-tags`. The tag starts the pipeline: the image with the tags above and a GitHub Release.

Versions with a hyphen (`1.0.0-rc.1`) are marked as prereleases and do not move `latest`.

One-time step after the first push: the package in GHCR is **private** by default. To make it pullable without signing in go to *GitHub → Packages → simpleipam → Package settings → Change visibility → Public* (the repository is public, but the package visibility is set separately).

## Permissions

The first account (the first-run screen) becomes the global Admin; later registrations have the None role until an Admin grants permissions (Administration → *Users*).
The most specific role applies: **location → tenant → global** (e.g. Reader on the tenant + None on lab2 = no access to lab2). Registration can be turned off in the *Settings* tab.

| Role | Scope |
|---|---|
| Reader | view, search, CSV export |
| Contributor | + add/edit/delete entries, scan, import |
| Admin (location) | + edit the location, add/edit/delete networks |
| Admin (tenant) | + add/delete locations in the tenant |
| Admin (global) | + create/delete tenants, users and roles, audit log, backups |

Sessions are an HttpOnly/SameSite=Lax cookie (the Secure flag is set behind an HTTPS proxy or with `COOKIE_SECURE=1`). Passwords are hashed with scrypt.
When publishing on the internet use HTTPS (a reverse proxy) — registration is open, but new accounts have no access to anything.

## API

Create a token in the app (the `</>` item in your profile menu). A token has the same permissions as its owner:

```sh
curl -H "Authorization: Bearer ipam_..." http://localhost:8080/api/overview
curl -H "Authorization: Bearer ipam_..." -H "content-type: application/json" \
  -d '{"ip":"192.168.1.50","fqdn":"printer.home.lan","type":"printer"}' http://localhost:8080/api/networks/1/entries
```

All endpoints are documented in the app: `/api/docs` (a readable page) and `/api/openapi.json` (OpenAPI 3, for import into Postman/Insomnia or client generators).

## Periodic scan

Networks with "Scan automatically" enabled are pinged every `SCAN_INTERVAL_MIN` minutes (15 by default, `0` disables it). Hosts that answer get a "seen" timestamp, and unknown ones land on the "New devices" list. The container needs access to the scanned network (`network_mode: host`).

## DNS consistency

The **DNS** button on a network resolves the FQDN of every entry (from the server, so it honours its resolver and `/etc/hosts`) and lists names with no A record or pointing at another address.

## Entries that expire and the growth forecast

An entry can have a **valid until** date (a guest, a lab machine). Expired entries and ones expiring within 14 days show up under "To review". The same list warns when a network is more than 90% full or, judging by the entries created in the last 60 days, will run out of free addresses within 180 days.

## Backups

Administrator panel → **Backups**:

- **Download now** — a fresh, consistent snapshot of the database (an SQLite file) straight to the browser.
- **Daily backup** — once a day the app saves a backup to `/data/backups` (you set how many to keep in the panel, 7 by default; an empty `BACKUP_DIR=` disables local backups). The files can be downloaded or deleted from the panel.
- **Cloud** — pick a provider, enter the credentials and enable "Upload the daily backup to the cloud automatically". The **Test connection** button uploads a small `simpleipam-connection-test.txt`.
  - *S3*: bucket, region, Access Key and Secret. For MinIO/R2/Backblaze also give a custom endpoint.
  - *GCS*: a bucket and the service account JSON key (a role that can write objects, e.g. Storage Object Creator).
  - *Google Drive*: in Google Cloud Console enable the Drive API, create an OAuth client ID and enter the Client ID/Secret in the app, then click **Connect to Google**. The app only gets the `drive.file` scope (it sees only its own backup folder). The redirect URI is `<app address>/api/admin/backups/gdrive/callback` and Google accepts only `https://` or `localhost`; for an address like `http://192.168.x.x` use a "TVs and Limited Input devices" client and the **Connect with a device code** button. Put the OAuth app in "In production" mode, because in "Testing" the token expires after 7 days.
- The app only **uploads** files — set retention with the bucket's lifecycle rules, and give the key minimal permissions.
- Access keys are stored in the database (the API never returns them), so they end up in backups too. Treat backups as confidential.
- **Encryption** — an optional passphrase (AES-256-GCM, files `*.db.enc`) covers local and cloud backups. Keep the passphrase outside the app: `BACKUP_PASSPHRASE=… node src/cli.js decrypt file.db.enc file.db`.

### Restoring

Administrator panel → **Backups**: the clock icon next to a backup in the list, or **Restore from file** (a `.db` file downloaded earlier or from the cloud).

1. The app checks the file (is it a simpleIPAM database, `integrity_check`) and upgrades an older backup to the current schema by itself.
2. It shows a "now → after restore" comparison and warnings, e.g. when the backup has no global administrator or lacks your account.
3. After you confirm it saves a **safety backup of the current state** (in the backup list — restoring it undoes the operation), swaps the database without a restart and signs everyone out.

Everything in the database is restored: data, users, roles, API tokens and backup settings (including the cloud keys). Downloading a file from S3/GCS is done outside the app; the upload limit is `MAX_UPLOAD_MB` (512 by default). If you lose access to the administrator account after a restore: `docker exec -it <container> node src/cli.js reset-admin <username>`.

## Change history and MAC change detection

Every entry has a history (the clock icon in the row; "History" above the table shows the whole network): who changed what and when (old → new value). The scan reads MAC addresses from the ARP table; when a known IP address answers with a different MAC than the stored one, the entry gets a warning with the buttons "Accept" (stores the new MAC) and "Ignore". The app sees a MAC only in its own L2 segment, so on Linux in Docker run the container with `network_mode: host` (in bridge mode the scan still works, but without MACs).

## UniFi integration

Administration → Settings → "UniFi (Site Manager)". One API key from unifi.ui.com is enough (it must belong to the console owner): the app connects to `api.ui.com` and reads the Network API of every selected console through the Cloud Connector (Cloud Gateway, UDM…; UniFi OS ≥ 5.0.3, console online in the cloud).

- **Import (UniFi → simpleIPAM).** Each console becomes a location in the chosen tenant, networks get the VLAN, gateway, DHCP range and DNS, network devices (gateways, switches, access points) and clients with fixed addresses become entries, and clients from the DHCP pool go to "new devices" (option: as entries too). Every client shows what it is attached to ("↳ AP Living room"). Existing data is not overwritten — only empty fields are filled in, and a MAC different from the stored one is reported as a warning.
- **Aliases (two-way).** A client's name in UniFi goes to the entry's **Alias** field: an alias changed in UniFi is mirrored in IPAM unless it was changed in IPAM too (when both sides changed, IPAM wins). In the other direction "Send aliases to UniFi" (first "Preview alias push") renames clients in UniFi through the classic API, by MAC address; only clients UniFi already knows are touched, and a cleared alias never wipes the name in UniFi. After the first successful manual write you can enable automation: an alias saved in IPAM reaches UniFi right away, and every sync makes up for anything missed.
- **DHCP reservations.** "Send DHCP reservations to UniFi" (first "Preview DHCP reservations") makes entries with status *Reserved* and a MAC into fixed IPs of the matching known client; the UniFi network is matched by CIDR.
- **Checks.** "Check write access to UniFi" (read-only) shows whether the key reaches the classic API. "Preview" shows what would happen without writing; the sync can run every hour.

## Sign in with Google

Administration → Settings → "Sign in with Google". In Google Cloud Console create an OAuth client of type "Web application" with the redirect URI `<app address>/api/auth/google/callback` (https or localhost) and enter the Client ID/Secret. New Google accounts are created without permissions (role None) and are subject to the "Open registration" switch; you link an existing account to Google in the "Change password" window. The first administrator is always created locally.

## Resetting the administrator password

```sh
docker exec -it <container> node src/cli.js reset-admin <username> [new-password]   # generates a random one without a password
```

## Development

```sh
cd server && npm test && DB_PATH=../data/ipam.db npm start   # API on :8080 (Node >= 24)
cd web && npm install && npm run dev                          # UI on :5173, proxies to :8080
```

### Translating the interface

The Polish text in the code is the translation key. `web/src/i18n/en.js` and `de.js` map it to English and German; `{name}` placeholders are filled in at run time. Messages built by the server (errors, the "To review" list) are translated in the browser by matching the same keys, so they need entries too. `server/test/i18n.test.js` checks that both dictionaries cover the same keys and placeholders.
