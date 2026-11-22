# Changelog

All notable changes to simpleIPAM are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Phones: the entries table becomes one card per address (IP, status, name, type, MAC and actions visible without sideways scrolling) and navigation moves to a floating bottom dock (Home / Review / Search / Menu) with a dimmed backdrop behind the side drawer.
- Responsive polish: fluid headline and page padding, usage stats reflow to 3 / 2 columns, modals and cards react to their own width (container queries), a sticky table header on wide screens, tabular numerals for addresses.
- Page changes cross-fade through the View Transitions API (skipped when reduced motion is requested).

### Fixed
- The "Export" and "Columns" dropdowns in the network toolbar were positioned like the profile menu and could float in a corner; they now open under their button and flip when near the window edge.
- "New devices" rows no longer push their buttons off the screen on phones.

## [0.15.0] - 2026-11-22

### Added
- Notifications (Administration → Settings): a message to ntfy or a generic JSON webhook (Slack/Discord-compatible) when a scan or UniFi finds a new device, a known device shows up at a different address, or a MAC changes. Findings from one scan are sent as a single message; the URL is write-only and there is a "Send test" button. API: `GET/PUT /api/admin/notify`, `POST /api/admin/notify/test`.

## [0.14.0] - 2026-11-22

### Added
- "What changed" card on every network (last 24 h / 7 / 30 days): hosts that appeared, hosts that stopped responding, entries added and removed. Backed by `GET /api/networks/:id/changes`.
- New warning in "To review" when a newly discovered host carries the MAC of a known entry at another address (device moved, or the same hardware has two addresses).
- Hovering a map cell highlights its table row and the other way round; the DHCP pool is marked on the map's row labels.
- On phones the map uses rows of 8 with larger cells, and the first tap only selects (a bar offers Edit / Add).

### Changed
- A blank alias field is hidden until the row is focused, so the table rows are about half as tall.
- Location colours in the planner come from a fixed palette that matches the app.
- Contrast raised to WCAG AA for text on the light theme (accent, warning, muted) and on DHCP map cells; bigger touch targets on coarse pointers.

## [0.13.0] - 2026-11-22

### Changed
- UI redesign: teal "patch cable" palette (light and dark), IBM Plex Sans/Mono bundled with the app (no CDN), flatter surfaces with smaller radii, no all-caps table headers, and the usage tiles became a single ruled strip.
- The address map is now a patch panel: rows of 16 with the row's starting address on the left and the last octet shown in every cell.

## [0.12.1] - 2026-11-14

### Changed
- Entries inside the DHCP pool without a DHCP reservation are treated as dynamic leases and no longer produce a "static or dynamic?" notice in "To review".

## [0.12.0] - 2026-11-14

### Added
- **Azure integration** (Administration → Integrations): sign in as a service principal (directory ID, client ID, client secret; Reader role is enough) and import read-only. Every selected subscription becomes a location, every VNet subnet a network (the `.1` address as gateway), and network interfaces (VMs, private endpoints) and internal load balancer frontends become entries. Preview, "Check access" probe, optional hourly sync. The secret is write-only.

## [0.11.0] - 2026-11-14

### Added
- **Address planning** per tenant (sidebar "Address planning" / `#/plan/<tenant>`): define address pools (e.g. `10.0.0.0/8`), see how much is allocated and which aligned blocks are still free, and allocate the next free subnet to a location in one step (creates the network with the first usable address as gateway). Conflicts (networks overlapping across locations, networks straddling a pool border) are listed.
- **VLAN registry** per tenant (whole tenant or one location) with the networks using each VLAN, a list of VLAN numbers used but not defined, and a hint in "To review" when a network uses an undefined VLAN or two networks of a location share a VLAN.
- Network address, default gateway and broadcast address are shown as pinned system rows and on the address map. The gateway shows its MAC and when it was last seen; "Save as entry" turns it into a normal entry. The network form can fill the gateway with the first or last address.
- API: `GET /api/tenants/:id/plan`, pools (`/api/tenants/:id/pools`, `/api/pools/:id`, `/suggest`, `/allocate`) and VLANs (`/api/tenants/:id/vlans`, `/api/vlans/:id`).

### Fixed
- A scan no longer reports the gateway (usually `.1`) as a new, unassigned host.
- Entries can no longer be created on the network or broadcast address, and the gateway cannot be set to either.

## [0.10.2] - 2026-11-14

### Changed
- Administration: Google sign-in and UniFi moved from Settings to a new "Integrations" tab; Settings keeps access and system info.

## [0.10.1] - 2026-11-14

### Changed
- Changing a password (your own or another user's) asks for the new password twice; your own also still requires the current one.

## [0.10.0] - 2026-11-14

### Added
- **Export to Excel** (`.xlsx`): one network from the Export menu, or every network you can read as one workbook (a sheet per network, also on the home page). Labels follow the interface language; written without any library.
- **"To review" page** in the sidebar: every warning from every network in one list (errors first, filterable), with a counter in the sidebar and on each network.
- Undo: saving an inline edit and deleting entries (one or many) show a toast with "Undo"; deleting asks in a proper dialog instead of the browser's confirm box. A cell shows a tick when its edit was saved.
- Network tiles and the address map now split Static / DHCP reservation / Dynamic / DHCP pool; the entry filter has Static, DHCP pool and Reservations.

### Changed
- The entries table is more compact: FQDN and alias share one cell (alias below), "last seen" sits under the IP, and MAC / Type / Description can be hidden from the "Columns" menu. Tags are clickable filters.

## [0.9.0] - 2026-11-14

### Changed
- Entry status now follows the DHCP pool: outside the pool an address is **Static** (there is nothing to reserve), inside it is **Dynamic (DHCP)** or a **DHCP reservation**. The status dropdowns show only the choices that make sense for the address.
- "To review": a reservation inside the pool is no longer flagged; a plain "used" entry in the pool is pointed out as dynamic-or-conflict, and a "Reserved" entry outside the pool is flagged as pointless.
- DHCP reservations to UniFi only cover reserved entries inside the pool; static ones are skipped.

## [0.8.2] - 2026-11-14

### Changed
- Theme and language switches are icon buttons in the top bar, next to Administration (the language one opens a small PL / EN / DE menu); they were in the profile menu before.

## [0.8.1] - 2026-11-14

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
