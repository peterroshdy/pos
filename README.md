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

1. Install Docker Desktop once.
2. Extract the Talk & TASTE folder.
3. Double-click `windows\Start Talk & TASTE.cmd`.
4. On first launch, choose the `admin` password and the `Barista` password.

No `.env`, branch ID, device ID, JWT secret, or terminal command is required. The launcher starts Docker Desktop when necessary, builds the app, waits until it is healthy, opens `http://localhost:8080`, and installs a per-user Windows startup shortcut automatically.

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
