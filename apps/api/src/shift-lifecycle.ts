import {
  enqueueSync,
  inTransaction,
  insertAudit,
  type SqliteDatabase,
} from "./database.js";

const MAX_SHIFT_AGE_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;

type Logger = {
  info: (value: unknown, message?: string) => void;
  warn: (value: unknown, message?: string) => void;
};

type ExpiredShift = {
  id: string;
  branch_id: string;
  user_id: string;
  opened_at: string;
  opening_cash: number;
};

export function closeExpiredShifts(
  db: SqliteDatabase,
  now = new Date(),
) {
  const cutoff = new Date(now.getTime() - MAX_SHIFT_AGE_MS).toISOString();
  const shifts = db
    .prepare(
      `SELECT id,branch_id,user_id,opened_at,opening_cash
       FROM shifts WHERE status='open' AND opened_at<=? ORDER BY opened_at`,
    )
    .all(cutoff) as unknown as ExpiredShift[];
  const closed: string[] = [];

  for (const shift of shifts) {
    const openedAt = Date.parse(shift.opened_at);
    if (!Number.isFinite(openedAt)) continue;
    const closedAt = new Date(openedAt + MAX_SHIFT_AGE_MS).toISOString();
    const expected =
      Number(shift.opening_cash) +
      Number(
        (
          db
            .prepare(
              `SELECT COALESCE(SUM(amount),0) AS amount
               FROM treasury_movements
               WHERE shift_id=? AND payment_method='cash' AND type!='opening_cash'`,
            )
            .get(shift.id) as { amount: number }
        ).amount,
      );

    inTransaction(db, () => {
      const result = db
        .prepare(
          `UPDATE shifts
           SET status='closed',closed_at=?,expected_cash=?,closing_cash=NULL,
               difference=NULL,close_note='Automatically closed after 24 hours'
           WHERE id=? AND status='open'`,
        )
        .run(closedAt, expected, shift.id);
      if (result.changes !== 1) return;
      insertAudit(db, {
        branchId: shift.branch_id,
        userId: shift.user_id,
        action: "shift.auto_closed",
        entityType: "shift",
        entityId: shift.id,
        originalValue: { status: "open", openedAt: shift.opened_at },
        newValue: {
          status: "closed",
          closedAt,
          expected,
          closingCash: null,
          difference: null,
          automatic: true,
        },
        reason: "Maximum shift duration of 24 hours reached",
      });
      enqueueSync(
        db,
        shift.branch_id,
        "shift",
        shift.id,
        "shift.closed",
        {
          id: shift.id,
          userId: shift.user_id,
          closedAt,
          expected,
          closingCash: null,
          difference: null,
          automatic: true,
          reason: "Maximum shift duration of 24 hours reached",
        },
      );
      closed.push(shift.id);
    });
  }
  return closed;
}

export function startShiftAutoCloser(db: SqliteDatabase, logger: Logger) {
  const run = () => {
    try {
      const closed = closeExpiredShifts(db);
      if (closed.length)
        logger.info(
          { shiftIds: closed, count: closed.length },
          "Automatically closed shifts older than 24 hours",
        );
    } catch (error) {
      logger.warn({ error }, "Automatic shift closing failed; it will retry");
    }
  };
  run();
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
