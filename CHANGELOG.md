# Changelog

All notable changes to simpleIPAM are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
