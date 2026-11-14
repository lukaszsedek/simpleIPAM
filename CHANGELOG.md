# Changelog

All notable changes to simpleIPAM are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Theme has a third mode, "system" (follows the OS live); the profile menu cycles light → dark → system.
- Accessibility: "skip to content" link, Tab stays inside open dialogs and focus returns to what opened them, table headers sort from the keyboard, reduced-motion is respected, slightly darker muted text in the light theme.

### Fixed
- The Administration → Settings page no longer scrolls sideways on a phone (long UniFi toggles now wrap).
- The Backups and Settings tab labels were not translated.

## [0.8.0] - 2026-11-14

### Added
- DHCP reservations to UniFi: entries with status "Reserved" and a MAC can be pushed as fixed IPs of the matching known UniFi client (preview first; same safety rules as the alias push).
- "DNS" check on a network: resolves every FQDN and lists the entries with a missing or different A record.

## [0.7.0] - 2026-11-14

### Added
- The interface is available in **Polish, English and German**. The language follows the browser by default and can be switched in the profile menu or on the sign-in screen; messages from the server (errors, "To review") are translated too.

### Changed
- README and the OpenAPI/`/api/docs` documentation are now in English.

## [0.6.1] - 2026-11-14

### Added
- Entries can have a "Ważny do" (valid until) date; expired or soon-expiring entries appear under "Do sprawdzenia".
- Growth forecast: a network over 90% full, or on course to run out within 180 days, is flagged under "Do sprawdzenia".

## [0.6.0] - 2026-11-14

### Added
- UniFi import now also brings network devices (gateways, switches, access points) as typed entries (model and firmware in the description), and shows which AP/switch each client is attached to ("↳ AP Salon" under the FQDN).

### Changed
- Administration link and the profile menu (API tokens, password, theme, log out) moved from the sidebar to the top-right corner.

## [0.5.1] - 2026-11-14

### Changed
- Sidebar: after logging in only the list of locations is shown; networks unfold on click (chevron). The location holding the currently open network stays expanded.

## [0.5.0] - 2026-11-14

### Added
- Aliases now flow both ways with UniFi. simpleIPAM → UniFi: "Wyślij aliasy do UniFi" (with a preview) renames known UniFi clients by MAC through the classic Network API; after the first successful write an admin can switch on automatic push, which sends an alias right after it is saved in simpleIPAM and again on every sync. Safeguards: only clients UniFi already knows are renamed, an emptied alias never clears a name in UniFi, at most 40 writes per run, and a failed write never marks the feature as verified.

## [0.4.2] - 2026-11-14

### Changed
- New logo: the address map (gateway, used, reserved and free addresses) as an app icon — sidebar, login screen, SVG favicon, README and API docs page.

## [0.4.1] - 2026-11-14

### Changed
- Sidebar network entries use two lines (name with ellipsis + VLAN pill, then CIDR and usage), so long names no longer collide with the VLAN and address.

### Added
- Entries have an **alias** (friendly device name). UniFi → simpleIPAM sync: a client renamed in UniFi updates the alias; the alias last seen in UniFi is remembered, so a change made only in simpleIPAM is kept and, when both sides changed, simpleIPAM wins (reported as a conflict in the sync summary).
- "Sprawdź zapis do UniFi": a read-only probe showing whether the API key reaches the classic Network API where UniFi keeps client aliases (groundwork for writing aliases back to UniFi).

## [0.4.0] - 2026-11-14

### Added
- UniFi import through Ubiquiti Site Manager (one API key, `api.ui.com` cloud connector): per console a site with its networks (VLAN, gateway, DHCP range, DNS), static clients as entries, DHCP-pool clients as "new devices"; preview (dry run), manual or hourly sync; UniFi-reported MACs feed MAC-change detection. Existing data is never overwritten.

## [0.3.0] - 2026-11-14

### Added
- Change history per entry and per network (who changed what, old → new), including CSV import and bulk edits; survives deleting the entry.
- MAC change detection: scans read the ARP table; a known IP answering with a different MAC raises a warning (accept / ignore), entries without a MAC get a suggestion. Needs the container to share the LAN segment (`network_mode: host`).
- OpenAPI 3 description of the whole API (`/api/openapi.json`) and a readable docs page (`/api/docs`); a test fails when a route is added without documentation.
- Optional passphrase encryption (AES-256-GCM) of scheduled backups, local and remote (`.db.enc`); restore asks for the passphrase when needed; `cli.js decrypt` for offline use.
- Unlink a Google account from a user (only once the account has a password); Google-created accounts can set a first password without a current one.
- Sign in with Google (OpenID Connect + PKCE): enabled by an admin in Ustawienia, new Google users start with role None and respect closed registration; existing accounts can link a Google account.

## [0.2.0] - 2026-11-12

### Added
- Google Drive as a backup destination: one-time "Connect with Google" sign-in (OAuth 2.0 authorization code + PKCE, or device code for LAN/http installs), `drive.file` scope only, own folder, retention of the newest N backups.
- Restore from a backup stored in Google Drive (list + "Przywróć" button); the per-file restore buttons in the local list now carry a label.

## [0.1.0] - 2026-11-12

First release.

### Added
- IPAM data model: tenant → site → network (CIDR, VLAN, gateway, DHCP range, DNS) → entries (IP, FQDN, MAC, type, status, tags).
- Web UI: dark/light theme, command palette (Cmd/Ctrl+K), address map of a network, inline editing, sorting, bulk edit.
- First-run screen "Create the administrator account"; every later sign-up starts with role None until an admin grants access (pending users are flagged in the admin panel).
- Users and roles: registration and login; Admin, Contributor, Reader and None assigned globally, per tenant or per site (most specific wins); personal API tokens.
- Consistency checks (duplicate MAC/FQDN, entries inside the DHCP pool, overlapping networks), "next free IP", free-subnet finder.
- Ping scan (manual and periodic) with "last seen" and a list of newly discovered hosts.
- Import/export CSV; export to hosts, dnsmasq and BIND formats.
- Admin panel: users, backups, settings, audit log.
- Backups: download, daily local copy, upload to AWS S3 (and S3-compatible stores) or Google Cloud Storage; restore from the UI with preview and automatic safety copy.
- Upgrade path for databases created before tenants existed.
- Single Docker image (amd64 and arm64) with embedded SQLite, published to GitHub Container Registry.
