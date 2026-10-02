import { randomUUID } from "node:crypto";
import {
  enqueueSync,
  getRuntimeValue,
  inTransaction,
  insertAudit,
  type SqliteDatabase,
} from "./database.js";

type Logger = {
  info: (value: unknown, message?: string) => void;
  warn: (value: unknown, message?: string) => void;
};
type OutboxRow = {
  sequence: number;
  id: string;
  branch_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: string;
  attempts: number;
  created_at: string;
};

type InboxEvent = {
  cursor: number;
  event_id: string;
  event_type: "inventory.transfer_dispatched" | "inventory.transfer_received";
  payload: Record<string, unknown>;
  received_at: string;
};

type InboxResponse = { events: InboxEvent[]; cursor: number };

const textValue = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

export function applyInboxEvent(
  db: SqliteDatabase,
  event: InboxEvent,
  branchId: string,
) {
  if (
    db.prepare("SELECT 1 FROM sync_inbox WHERE event_id=?").get(event.event_id)
  )
    return;

  const timestamp = new Date().toISOString();
  if (event.event_type === "inventory.transfer_received") {
    const transferId = textValue(
      event.payload.transferId ?? event.payload.id ?? event.payload.transfer_id,
    );
    if (!transferId)
      throw new Error("Received transfer acknowledgement has no ID");
    inTransaction(db, () => {
      db.prepare(
        "UPDATE inventory_transfers SET status='received',received_at=? WHERE id=? AND source_branch_id=?",
      ).run(timestamp, transferId, branchId);
      db.prepare(
        "INSERT INTO sync_inbox (event_id,event_type,payload,processed_at) VALUES (?, ?, ?, ?)",
      ).run(
        event.event_id,
        event.event_type,
        JSON.stringify(event.payload),
        timestamp,
      );
    });
    return;
  }

  const payload = event.payload;
  const destinationBranchId = textValue(payload.destinationBranchId);
  const sourceBranchId = textValue(payload.sourceBranchId);
  const sourceItemId = textValue(payload.itemId);
  const sku = textValue(payload.sku).toUpperCase();
  const itemType = textValue(payload.itemType);
  const quantity = Number(payload.quantity);
  const unit = textValue(payload.unit) || "pieces";
  const reason = textValue(payload.reason) || "Inter-branch transfer";
  const transferId = textValue(payload.id) || event.event_id;
  if (
    destinationBranchId !== branchId ||
    !sourceBranchId ||
    !sourceItemId ||
    !["product", "ingredient"].includes(itemType) ||
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    throw new Error("Invalid incoming inventory transfer payload");
  }
  const user = db
    .prepare(
      "SELECT id FROM users WHERE branch_id=? AND active=1 ORDER BY is_super_admin DESC,created_at LIMIT 1",
    )
    .get(branchId) as { id: string } | undefined;
  if (!user)
    throw new Error(`No active local user exists for branch ${branchId}`);

  inTransaction(db, () => {
    let localItemId = sourceItemId;
    let itemName = textValue(payload.name) || sku || sourceItemId;
    if (itemType === "product") {
      const product = db
        .prepare(
          `SELECT id,name,stock FROM products WHERE active=1 AND (id=? OR sku=?)
           ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1`,
        )
        .get(sourceItemId, sku, sourceItemId) as
        { id: string; name: string; stock: number } | undefined;
      if (!product)
        throw new Error(
          `Product ${sku || sourceItemId} must exist in the destination catalog before receiving stock`,
        );
      localItemId = product.id;
      itemName = product.name;
      const after = Number(product.stock) + quantity;
      db.prepare("UPDATE products SET stock=?,updated_at=? WHERE id=?").run(
        after,
        timestamp,
        localItemId,
      );
      db.prepare(
        `INSERT INTO inventory_movements
         (id,product_id,branch_id,type,quantity,before_quantity,after_quantity,reference_type,reference_id,reason,user_id,created_at)
         VALUES (?, ?, ?, 'transfer_in', ?, ?, ?, 'transfer', ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        localItemId,
        branchId,
        quantity,
        Number(product.stock),
        after,
        transferId,
        reason,
        user.id,
        timestamp,
      );
    } else {
      let ingredient = db
        .prepare(
          "SELECT id,name,stock_quantity FROM inventory_items WHERE branch_id=? AND active=1 AND (id=? OR sku=?) ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1",
        )
        .get(branchId, sourceItemId, sku, sourceItemId) as
        { id: string; name: string; stock_quantity: number } | undefined;
      if (!ingredient) {
        localItemId = randomUUID();
        itemName = textValue(payload.name) || sku || "Transferred ingredient";
        db.prepare(
          `INSERT INTO inventory_items
           (id,branch_id,sku,name,name_ar,unit,stock_quantity,low_stock_at,cost_per_unit,updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        ).run(
          localItemId,
          branchId,
          sku || `TRANSFER-${sourceItemId.slice(0, 8)}`,
          itemName,
          textValue(payload.nameAr) || itemName,
          unit,
          Math.max(0, Number(payload.lowStockAt) || 0),
          Math.max(0, Number(payload.costPerUnit) || 0),
          timestamp,
        );
        ingredient = { id: localItemId, name: itemName, stock_quantity: 0 };
      }
      localItemId = ingredient.id;
      itemName = ingredient.name;
      const after = Number(ingredient.stock_quantity) + quantity;
      db.prepare(
        "UPDATE inventory_items SET stock_quantity=?,updated_at=? WHERE id=?",
      ).run(after, timestamp, localItemId);
      db.prepare(
        `INSERT INTO inventory_item_movements
         (id,inventory_item_id,branch_id,type,quantity,before_quantity,after_quantity,reference_type,reference_id,reason,user_id,created_at)
         VALUES (?, ?, ?, 'transfer_in', ?, ?, ?, 'transfer', ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        localItemId,
        branchId,
        quantity,
        Number(ingredient.stock_quantity),
        after,
        transferId,
        reason,
        user.id,
        timestamp,
      );
    }
    db.prepare(
      `INSERT INTO incoming_transfers
       (id,source_branch_id,destination_branch_id,item_type,item_id,item_name,quantity,unit,reason,received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      transferId,
      sourceBranchId,
      branchId,
      itemType,
      localItemId,
      itemName,
      quantity,
      unit,
      reason,
      timestamp,
    );
    insertAudit(db, {
      branchId,
      userId: user.id,
      action: "inventory.transfer_received",
      entityType: "inventory_transfer",
      entityId: transferId,
      newValue: { ...payload, localItemId, receivedAt: timestamp },
      reason,
    });
    enqueueSync(
      db,
      branchId,
      "inventory_transfer",
      transferId,
      "inventory.transfer_received",
      {
        transferId,
        sourceBranchId,
        destinationBranchId: branchId,
        itemType,
        itemId: localItemId,
        quantity,
        unit,
        receivedAt: timestamp,
      },
    );
    db.prepare(
      "INSERT INTO sync_inbox (event_id,event_type,payload,processed_at) VALUES (?, ?, ?, ?)",
    ).run(event.event_id, event.event_type, JSON.stringify(payload), timestamp);
  });
}

export function startSyncWorker(db: SqliteDatabase, logger: Logger) {
  let running = false;
  let announcedUnconfigured = false;
  const sync = async () => {
    if (running) return;
    const cloudUrl = (
      process.env.CLOUD_SYNC_URL || getRuntimeValue(db, "cloud_url") || ""
    ).replace(/\/$/, "");
    const credential =
      process.env.CLOUD_SYNC_TOKEN || getRuntimeValue(db, "cloud_sync_token");
    const deviceCredential =
      process.env.CLOUD_DEVICE_TOKEN ||
      getRuntimeValue(db, "cloud_device_token");
    const branchId = process.env.BRANCH_ID;
    if (!cloudUrl || !credential || !deviceCredential || !branchId) {
      if (!announcedUnconfigured) {
        logger.info(
          "Cloud sync is waiting for branch pairing; local operation remains available after setup",
        );
        announcedUnconfigured = true;
      }
      return;
    }
    const loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(
      cloudUrl,
    );
    if (
      process.env.NODE_ENV === "production" &&
      !cloudUrl.startsWith("https://") &&
      !loopback
    ) {
      logger.warn({ cloudUrl }, "Cloud sync URL must use HTTPS");
      return;
    }
    announcedUnconfigured = false;
    running = true;
    try {
      const rows = db
        .prepare(
          `SELECT * FROM sync_outbox
        WHERE synced_at IS NULL AND next_attempt_at <= ? ORDER BY sequence LIMIT 50`,
        )
        .all(new Date().toISOString()) as unknown as OutboxRow[];
      for (const row of rows) {
        try {
          const response = await fetch(`${cloudUrl}/api/sync/events`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${credential}`,
              "idempotency-key": row.id,
              "x-branch-id": row.branch_id,
              "x-device-token": deviceCredential,
            },
            body: JSON.stringify({
              eventId: row.id,
              branchId: row.branch_id,
              sequence: row.sequence,
              aggregateType: row.aggregate_type,
              aggregateId: row.aggregate_id,
              eventType: row.event_type,
              occurredAt: row.created_at,
              payload: JSON.parse(row.payload),
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok)
            throw new Error(`Cloud responded with ${response.status}`);
          db.prepare(
            "UPDATE sync_outbox SET synced_at = ?, last_error = NULL WHERE id = ?",
          ).run(new Date().toISOString(), row.id);
          if (row.aggregate_type === "order") {
            db.prepare(
              "UPDATE orders SET sync_status = 'synced' WHERE id = ?",
            ).run(row.aggregate_id);
          }
        } catch (error) {
          const attempts = row.attempts + 1;
          const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
          const retryAt = new Date(
            Date.now() + delaySeconds * 1000,
          ).toISOString();
          db.prepare(
            "UPDATE sync_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
          ).run(
            attempts,
            retryAt,
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Unknown sync error",
            row.id,
          );
          if (row.aggregate_type === "order")
            db.prepare(
              "UPDATE orders SET sync_status = 'error' WHERE id = ?",
            ).run(row.aggregate_id);
          logger.warn(
            { eventId: row.id, attempts, error },
            "Cloud sync attempt failed; event remains queued",
          );
          break;
        }
      }
      try {
        const cursorRow = db
          .prepare(
            "SELECT value FROM sync_state WHERE key='cloud_inbox_cursor'",
          )
          .get() as { value: string } | undefined;
        let cursor = Math.max(0, Number(cursorRow?.value ?? 0) || 0);
        const inboxResponse = await fetch(
          `${cloudUrl}/api/sync/inbox?after=${cursor}`,
          {
            headers: {
              authorization: `Bearer ${credential}`,
              "x-branch-id": branchId,
              "x-device-token": deviceCredential,
            },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!inboxResponse.ok)
          throw new Error(`Cloud inbox responded with ${inboxResponse.status}`);
        const inbox = (await inboxResponse.json()) as InboxResponse;
        for (const event of inbox.events) {
          applyInboxEvent(db, event, branchId);
          cursor = event.cursor;
          db.prepare(
            `INSERT INTO sync_state (key,value) VALUES ('cloud_inbox_cursor',?)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
          ).run(String(cursor));
        }
      } catch (error) {
        logger.warn(
          { error },
          "Cloud inbox pull failed; incoming events will be retried",
        );
      }
    } finally {
      running = false;
    }
  };

  void sync();
  const timer = setInterval(() => void sync(), 15_000);
  timer.unref();
  return () => clearInterval(timer);
}
