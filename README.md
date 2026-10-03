# Talk & TASTE

Talk & TASTE is a bilingual Arabic/English cafe management system with an offline-first Windows POS and a central cloud Admin service.

## Account model

Staff accounts use usernames, never email addresses.

- `admin` is the Super Admin. Its Admin role has all management permissions but no POS access.
- `Barista` is permission-driven. Its role contains only `pos.access`, `pos.drawer`, `pos.history`, `pos.shift`, and `pos.reprint`.

The Barista can open and close a shift, build and complete the current order, view only their own shift history, take payment, print its receipt, and trigger the drawer. It cannot access products management, inventory management, customers management, staff, permissions, branches, treasury, reports, settings, historical transaction changes, voids, or refunds.

Admin includes a dedicated **Shifts** section with shift duration, opening/closing cash, expected versus counted cash, variance, payment breakdown, and rolling 24-hour employee aggregation.

## Branch model

There is no cashier or register entity. The structure is simply:

```text
Branch → one Windows POS device
```

Branches are created only in Cloud Admin. Each branch card has **Pair Windows Device**, which creates a single-use code valid for 30 minutes. The Windows installation enters that code in **Settings → Cloud synchronization** and adopts the cloud branch identity.

The current testing branch is **City Stars Branch**.

## Windows branch setup

### Windows prerequisites

- A supported 64-bit Windows 11 installation (23H2 or newer is recommended for branch machines).
- CPU virtualization enabled in BIOS/UEFI and WSL 2 enabled. Docker currently requires WSL 2.1.5 or newer and 8 GB system RAM for its WSL backend.
- Docker Desktop configured to use Linux containers. This is the only separate application runtime required; Node.js, npm, Git, Python, and SQLite do not need to be installed on the POS machine.
- Microsoft Edge for the dedicated app window and silent receipt printing. The POS still opens in the default browser if Edge is unavailable, but silent printing is then unavailable.
- The Windows driver and printer queue for the XP-Q808K when receipt printing or the connected cash drawer is required.
- Internet access for the initial Docker image build and optional cloud pairing. Checkout continues locally when the internet is unavailable after installation.

PowerShell is already included with supported Windows versions and is used by the launcher and hardware bridge.

### Native Windows 10 installation for a 4 GB POS

Use the native installer on a low-memory Windows 10 touchscreen. It does not use Docker or WSL. Keep the Windows page file enabled and leave the cloned folder in a permanent location.

Before cloning, install Git for Windows. Microsoft Edge and the XP-Q808K Windows driver should also be installed. Node.js does not need to be installed manually: the installer downloads the current Node.js 24 x64 MSI from `nodejs.org`, verifies its published SHA-256 checksum, and opens the normal Windows installer prompt.

After `git clone`, no terminal typing is needed:

1. Open the cloned `pos\windows` folder.
2. Double-click **Install Talk & TASTE Native.cmd**.
3. Approve the Windows administrator prompt for Node.js if it appears.
4. Wait for the success message and create the local `admin` and `Barista` passwords in the browser.

The installer builds the application, stores the database under `%LOCALAPPDATA%\TalkAndTaste\data`, creates a desktop shortcut, registers automatic startup after Windows login, starts the printer/cash-drawer bridge, and opens Edge in POS app mode. A hidden watchdog restarts the local API within five seconds if Node.js exits unexpectedly. The API and hardware bridge bind to the local machine only. Startup also keeps one local database backup per day under `%LOCALAPPDATA%\TalkAndTaste\backups` and retains the latest 14 backups. To install future versions without terminal typing, double-click **Update Talk & TASTE Native.cmd**.

For the initial clone, run this once from Git CMD or Command Prompt:

```cmd
cd %USERPROFILE%\Desktop
git clone https://github.com/peterroshdy/pos.git TalkAndTaste
```

Then use only the double-click installer and updater above.

### Install

1. Install and start Docker Desktop once.
2. Extract the Talk & TASTE folder to a permanent location.
3. Double-click `windows\Start Talk & TASTE.cmd`.
4. On first launch, create the device-local `admin` password and the initial `Barista` password.

Every fresh installation requires first-run account setup. It creates a local Super Admin with username `admin` and a local POS employee with username `Barista`; there is no shared or hard-coded production password. Passwords are hashed in the local database and both accounts work offline. The setup cannot be run again after the local administrator exists, and the accounts persist in the `token_taste_data` Docker volume across application and Windows restarts.

No `.env`, branch ID, device ID, JWT secret, or terminal command is required. The launcher starts Docker Desktop when necessary, builds the app, waits until it is healthy, opens `http://localhost:8080`, and installs a per-user Windows startup shortcut automatically.

The same launcher starts the bundled Windows hardware bridge, automatically creates its private authentication token, finds the installed XP-Q808K queue, makes it the dedicated POS browser's default printer, and opens Microsoft Edge in app mode with silent printing enabled. A completed or reprinted receipt therefore prints through the normal Windows driver without a browser print dialog. `RECEIPT_PRINTER_NAME` may be placed in the automatically managed `.env` only when Windows has more than one matching Xprinter queue and an explicit queue is required.

The cash drawer plugs into the XP-Q808K's `DK`/drawer port. Manual drawer opening and cash checkout send the five-byte ESC/POS drawer pulse directly to the printer queue; they do not render a document, feed paper, cut paper, or print a blank receipt. The local API reports failure when the Windows bridge or printer is unavailable, and records successful and failed attempts separately in the audit log.

After a Windows restart and user login, that shortcut starts Docker Desktop, starts the existing POS container without rebuilding it, waits for the local health check, and opens `http://localhost:8080` automatically. Docker's `unless-stopped` policy also restarts the application process after a crash. The named `token_taste_data` Docker volume is not recreated, so users, the generated JWT secret, the paired branch identity, orders, held orders, the sync queue, and an open shift survive both application and Windows restarts. A Barista can sign in again and continue the same open shift; shifts are closed only through the counted-cash closing flow.

The installation can work offline for weeks. Orders, shifts, inventory movements, treasury records, and audit events commit to its local SQLite volume and enter a durable synchronization queue. Pairing can happen later:

1. Create or open the branch in Cloud Admin.
2. Select **Pair Windows Device**.
3. Copy the one-time code.
4. Enter it under **Settings → Cloud synchronization** on the Windows machine.

The installation then uploads its complete queued history. Future interruptions retry automatically. Back up the Windows device or Docker volume while unsynchronized data exists only locally.

Each committed operation writes its business record and durable outbox event to the same local SQLite database. The sync worker runs at startup and every 15 seconds, uploads in sequence, uses idempotent event IDs, and retries failures with backoff up to five minutes. Internet loss never blocks checkout. Cloud-to-branch inventory transfers are also downloaded from the authenticated inbox. The cloud Admin receives branch transaction, shift, treasury, inventory, customer, staff, settings, and audit events; the local database remains the checkout source of truth.

## Windows support and troubleshooting

If the POS is unavailable, first double-click `windows\Create Support Bundle.cmd` so the failure evidence is preserved, then double-click `windows\Start Talk & TASTE.cmd`. The start launcher safely starts Docker Desktop and the existing container; it does not erase or replace the data volume.

The support tool creates a timestamped ZIP on the Windows Desktop containing:

- Windows boot and disk information
- Docker and container status
- the latest 1,000 application log lines
- local health-check output
- cloud reachability status
- launcher logs
- installed Windows printer queues and default-printer status
- hardware-bridge health and hardware-bridge logs

The bundle deliberately excludes the SQLite database, passwords, tokens, and container environment. Send that ZIP to support. Do not run `docker compose down -v`, delete the `token_taste_data` volume, reset Docker Desktop, or uninstall Docker while unsynchronized local data exists.

Manual diagnostic commands, when support requests them:

```powershell
docker compose -f compose.yml ps
docker compose -f compose.yml logs --tail 200 branch
docker compose -f compose.yml restart branch
Invoke-RestMethod http://localhost:8080/api/health
```

## Infrastructure

```text
Cloud browser → HTTPS/nginx → cloud container → private SQLite volume

Branch browsers → local branch container → local SQLite volume
                                      ↓ when online
                          authenticated HTTPS synchronization
```

The cloud owns branch creation, branch pairing, cross-branch reporting, and synchronized events. Checkout depends only on the local branch service. Branch and device credentials, the JWT secret, and the provisional offline branch identity are generated automatically.

The Noto Sans Arabic webfont and its OFL license are bundled with the application, so Arabic works online and offline without Google Fonts.

## Development

```bash
npm install
npm run dev
```

The web app runs at `http://localhost:5173` and the API at `http://localhost:4100`.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run verify:first-run
npm run verify:integration
npm run verify:restart
npm audit --audit-level=high
docker compose config
docker compose -f compose.cloud.yml config
```

The cloud service is published at `https://admin.talkandtaste.app` through nginx. The application port and SQLite databases remain private.
