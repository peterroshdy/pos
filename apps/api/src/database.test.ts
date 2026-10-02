import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  getOrCreateRuntimeValue,
  inTransaction,
  type SqliteDatabase,
} from "./database.js";
import { applyInboxEvent } from "./sync-worker.js";

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
        "SELECT COUNT(*) AS count FROM role_permissions WHERE role_id='role-owner' AND permission IN ('pos.access','pos.drawer','pos.discount')",
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
