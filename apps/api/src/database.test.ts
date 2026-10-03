import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  getOrCreateRuntimeValue,
  inTransaction,
  type SqliteDatabase,
} from "./database.js";
import { applyInboxEvent } from "./sync-worker.js";
import { closeExpiredShifts } from "./shift-lifecycle.js";

describe("branch database", () => {
  let db: SqliteDatabase;
  beforeEach(() => {
    process.env.BOOTSTRAP_ADMIN_PASSWORD = "TestingOnly#2026";
    db = createDatabase(":memory:");
  });
  afterEach(() => db.close());

  it("seeds a bilingual catalog and separated Admin/Barista permissions", () => {
    const products = db
      .prepare("SELECT COUNT(*) AS count FROM products")
      .get() as { count: number };
    const arabic = db
      .prepare("SELECT COUNT(*) AS count FROM products WHERE name_ar != ''")
      .get() as { count: number };
    const granted = db
      .prepare(
        "SELECT COUNT(*) AS count FROM role_permissions WHERE role_id = 'role-owner'",
      )
      .get() as { count: number };
    expect(products.count).toBeGreaterThanOrEqual(14);
    expect(arabic.count).toBe(products.count);
    expect(granted.count).toBeGreaterThan(15);
    const adminPos = db
      .prepare(
        "SELECT COUNT(*) AS count FROM role_permissions WHERE role_id='role-owner' AND permission IN ('pos.access','pos.drawer','pos.discount','pos.shift')",
      )
      .get() as { count: number };
    const baristaPermissions = db
      .prepare(
        "SELECT permission FROM role_permissions WHERE role_id='role-barista' ORDER BY permission",
      )
      .all() as unknown as Array<{ permission: string }>;
    const baristaRole = db
      .prepare("SELECT system_role FROM roles WHERE id='role-barista'")
      .get() as { system_role: number };
    expect(adminPos.count).toBe(0);
    const adminShifts = db
      .prepare(
        "SELECT COUNT(*) AS count FROM shifts WHERE user_id='user-owner'",
      )
      .get() as { count: number };
    expect(adminShifts.count).toBe(0);
    expect(baristaPermissions.map((row) => row.permission)).toEqual([
      "pos.access",
      "pos.drawer",
      "pos.history",
      "pos.reprint",
      "pos.shift",
    ]);
    expect(baristaRole.system_role).toBe(0);
  });

  it("generates a temporary offline identity and waits for first-run owner setup", () => {
    const previousPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    const previousBranch = process.env.BRANCH_ID;
    delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
    delete process.env.BRANCH_ID;
    const fresh = createDatabase(":memory:");
    try {
      const owners = fresh
        .prepare("SELECT COUNT(*) AS count FROM users")
        .get() as { count: number };
      const branch = fresh
        .prepare("SELECT id FROM branches LIMIT 1")
        .get() as { id: string };
      expect(owners.count).toBe(0);
      expect(branch.id).toMatch(/^LOCAL-[A-F0-9]{8}$/);
      const registerTables = fresh
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='registers'")
        .get() as { count: number };
      expect(registerTables.count).toBe(0);
      const first = getOrCreateRuntimeValue(fresh, "jwt_secret", () => "first");
      const second = getOrCreateRuntimeValue(fresh, "jwt_secret", () => "second");
      expect(first).toBe("first");
      expect(second).toBe("first");
    } finally {
      fresh.close();
      if (previousPassword === undefined)
        delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
      else process.env.BOOTSTRAP_ADMIN_PASSWORD = previousPassword;
      if (previousBranch === undefined) delete process.env.BRANCH_ID;
      else process.env.BRANCH_ID = previousBranch;
    }
  });

  it("rolls back all writes when an atomic operation fails", () => {
    expect(() =>
      inTransaction(db, () => {
        db.prepare(
          "UPDATE products SET stock = stock - 5 WHERE sku = 'COF-001'",
        ).run();
        throw new Error("simulated checkout failure");
      }),
    ).toThrow("simulated checkout failure");
    const product = db
      .prepare("SELECT stock FROM products WHERE sku = 'COF-001'")
      .get() as { stock: number };
    expect(product.stock).toBe(80);
  });

  it("uses UUID identifiers for catalog records", () => {
    const rows = db
      .prepare("SELECT id FROM products")
      .all() as unknown as Array<{ id: string }>;
    expect(
      rows.every((row) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          row.id,
        ),
      ),
    ).toBe(true);
  });

  it("automatically closes shifts at the 24-hour limit", () => {
    const user = db
      .prepare("SELECT id,branch_id FROM users WHERE username='Barista'")
      .get() as { id: string; branch_id: string };
    const now = new Date("2026-10-03T12:00:00.000Z");
    const openedAt = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    const expectedClosedAt = new Date(
      openedAt.getTime() + 24 * 60 * 60 * 1000,
    ).toISOString();
    db.prepare(
      `INSERT INTO shifts
       (id,branch_id,user_id,opened_at,opening_cash,status)
       VALUES ('expired-shift',?,?,?,?, 'open')`,
    ).run(user.branch_id, user.id, openedAt.toISOString(), 12500);

    expect(closeExpiredShifts(db, now)).toEqual(["expired-shift"]);
    const closed = db
      .prepare(
        "SELECT status,closed_at,expected_cash,closing_cash,difference,close_note FROM shifts WHERE id='expired-shift'",
      )
      .get() as Record<string, unknown>;
    expect(closed).toMatchObject({
      status: "closed",
      closed_at: expectedClosedAt,
      expected_cash: 12500,
      closing_cash: null,
      difference: null,
      close_note: "Automatically closed after 24 hours",
    });
    const event = db
      .prepare(
        "SELECT event_type,payload FROM sync_outbox WHERE aggregate_id='expired-shift'",
      )
      .get() as { event_type: string; payload: string };
    expect(event.event_type).toBe("shift.closed");
    expect(JSON.parse(event.payload)).toMatchObject({ automatic: true });
    expect(closeExpiredShifts(db, now)).toEqual([]);
  });

  it("receives cloud inventory transfers exactly once", () => {
    const localBranch = db
      .prepare("SELECT branch_id FROM users WHERE id='user-owner'")
      .get() as { branch_id: string };
    const product = db
      .prepare("SELECT id,stock FROM products WHERE sku='COF-001'")
      .get() as { id: string; stock: number };
    const event = {
      cursor: 10,
      event_id: "transfer-event-1",
      event_type: "inventory.transfer_dispatched" as const,
      received_at: new Date().toISOString(),
      payload: {
        id: "transfer-1",
        sourceBranchId: "BR-REMOTE-01",
        destinationBranchId: localBranch.branch_id,
        itemType: "product",
        itemId: product.id,
        sku: "COF-001",
        name: "Turkish Coffee",
        quantity: 3,
        unit: "pieces",
        reason: "Restock",
      },
    };
    applyInboxEvent(db, event, localBranch.branch_id);
    applyInboxEvent(db, event, localBranch.branch_id);
    const updated = db
      .prepare("SELECT stock FROM products WHERE id=?")
      .get(product.id) as { stock: number };
    const received = db
      .prepare(
        "SELECT COUNT(*) AS count FROM incoming_transfers WHERE id='transfer-1'",
      )
      .get() as { count: number };
    expect(updated.stock).toBe(product.stock + 3);
    expect(received.count).toBe(1);
  });
});
