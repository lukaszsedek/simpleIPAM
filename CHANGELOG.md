# Changelog

All notable changes to simpleIPAM are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
