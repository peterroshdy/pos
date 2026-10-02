import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const db = new DatabaseSync(process.env.DATABASE_PATH ?? "/data/token-taste-cloud.db");
const iso = (date) => new Date(date).toISOString();
const dateOnly = (date) => new Date(date).toISOString().slice(0, 10);
const money = (value) => Math.round(value * 100);
const id = () => randomUUID();
const config = db.prepare("SELECT value FROM runtime_config WHERE key='demo_history_seeded_v1'").get();
if (config) {
  console.log("Demo history already seeded; nothing changed.");
  db.close();
  process.exit(0);
}

const branch = db.prepare("SELECT id FROM branches WHERE name='City Stars Branch' LIMIT 1").get();
const admin = db.prepare("SELECT id FROM users WHERE username='admin' LIMIT 1").get();
const barista = db.prepare("SELECT id FROM users WHERE username='Barista' LIMIT 1").get();
const products = db.prepare("SELECT id,name,name_ar,price,cost FROM products WHERE active=1 ORDER BY sku LIMIT 8").all();
if (!branch || !admin || !barista || products.length < 3) throw new Error("Expected City Stars Branch, admin, Barista, and catalog products");

let customerA = db.prepare("SELECT id FROM customers WHERE phone='01000000001' LIMIT 1").get();
let customerB = db.prepare("SELECT id FROM customers WHERE phone='01000000002' LIMIT 1").get();
const timestamp = iso(new Date());
if (!customerA) {
  customerA = { id: id() };
  db.prepare("INSERT INTO customers (id,name,phone,email,credit_approved,credit_limit,credit_balance,notes,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?, ?, ?)")
    .run(customerA.id, "Nour Hassan", "01000000001", "", 1000000, 0, "Regular customer", timestamp, timestamp);
}
if (!customerB) {
  customerB = { id: id() };
  db.prepare("INSERT INTO customers (id,name,phone,email,credit_approved,credit_limit,credit_balance,notes,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?, ?, ?)")
    .run(customerB.id, "Omar Adel", "01000000002", "", 750000, 0, "Office account", timestamp, timestamp);
}

const audit = (userId, action, entityType, entityId, at, extra = {}) => {
  db.prepare(`INSERT INTO audit_logs
    (id,branch_id,user_id,action,entity_type,entity_id,order_number,original_value,new_value,reason,metadata,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id(), branch.id, userId, action, entityType, entityId, extra.orderNumber ?? null,
      extra.originalValue ? JSON.stringify(extra.originalValue) : null,
      extra.newValue ? JSON.stringify(extra.newValue) : null,
      extra.reason ?? null, JSON.stringify(extra.metadata ?? {}), at);
};

const addTreasury = (shiftId, type, amount, paymentMethod, referenceType, referenceId, description, userId, at) => {
  db.prepare(`INSERT INTO treasury_movements
    (id,branch_id,shift_id,type,category,amount,payment_method,reference_type,reference_id,description,attachment,user_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id(), branch.id, shiftId, type, "demo", amount, paymentMethod, referenceType, referenceId, description, "", userId, at);
};

db.exec("BEGIN IMMEDIATE");
try {
  const now = new Date();
  const shifts = [];
  for (let dayOffset = 6; dayOffset >= 0; dayOffset--) {
    const day = new Date(now);
    day.setHours(9, 0, 0, 0);
    day.setDate(day.getDate() - dayOffset);
    const businessDate = dateOnly(day);
    let shift = db.prepare("SELECT id, status FROM shifts WHERE branch_id=? AND substr(opened_at,1,10)=? ORDER BY opened_at LIMIT 1").get(branch.id, businessDate);
    if (!shift) {
      shift = { id: id(), status: dayOffset === 0 ? "open" : "closed" };
      const openingCash = money(180 + (6 - dayOffset) * 15);
      const openedAt = iso(day);
      const closedAt = dayOffset === 0 ? null : iso(new Date(day.getTime() + 9 * 60 * 60 * 1000));
      db.prepare(`INSERT INTO shifts (id,branch_id,user_id,opened_at,opening_cash,closed_at,closing_cash,expected_cash,difference,close_note,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(shift.id, branch.id, barista.id, openedAt, openingCash, closedAt,
          dayOffset === 0 ? null : openingCash + money(420 + dayOffset * 32),
          dayOffset === 0 ? null : openingCash + money(420 + dayOffset * 32), 0,
          dayOffset === 0 ? "" : "Demo shift closed", shift.status);
      addTreasury(shift.id, "opening_cash", openingCash, "cash", "shift", shift.id, "Opening cash in drawer", barista.id, openedAt);
      audit(barista.id, "shift.opened", "shift", shift.id, openedAt, { newValue: { openingCash } });
      if (dayOffset !== 0) audit(barista.id, "shift.closed", "shift", shift.id, closedAt, { newValue: { closingCash: openingCash + money(420 + dayOffset * 32) } });
    }
    shifts.push({ ...shift, businessDate });
  }

  let orderIndex = 1;
  for (const shift of shifts) {
    const day = new Date(`${shift.businessDate}T10:15:00.000Z`);
    const count = 5 + (orderIndex % 4);
    for (let i = 0; i < count; i++) {
      const product = products[(i + orderIndex) % products.length];
      const quantity = 1 + (i % 2);
      const subtotal = Number(product.price) * quantity;
      const paymentMethod = i % 5 === 0 ? "credit" : i % 3 === 0 ? "card" : "cash";
      const customer = paymentMethod === "credit" ? (i % 2 ? customerA : customerB) : null;
      const orderId = id();
      const orderNumber = `DEMO-${shift.businessDate.replaceAll("-", "")}-${String(i + 1).padStart(2, "0")}`;
      const createdAt = iso(new Date(day.getTime() + i * 34 * 60 * 1000));
      db.prepare(`INSERT OR IGNORE INTO orders
        (id,client_request_id,order_number,branch_id,shift_id,user_id,customer_id,status,payment_method,subtotal,discount_amount,tax_amount,total,refunded_amount,note,void_reason,business_date,created_at,updated_at,sync_status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(orderId, id(), orderNumber, branch.id, shift.id, barista.id, customer?.id ?? null,
          "completed", paymentMethod, subtotal, 0, 0, subtotal, 0, "Demo sale", null, shift.businessDate, createdAt, createdAt, "synced");
      db.prepare(`INSERT OR IGNORE INTO order_items
        (id,order_id,product_id,variant_id,product_name,product_name_ar,variant_name,variant_name_ar,quantity,unit_price,unit_cost,total,note)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id(), orderId, product.id, null, product.name, product.name_ar, null, null, quantity, product.price, product.cost, subtotal, "");
      addTreasury(shift.id, "sale", subtotal, paymentMethod, "order", orderId, orderNumber, barista.id, createdAt);
      audit(barista.id, "order.completed", "order", orderId, createdAt, { orderNumber, newValue: { total: subtotal, paymentMethod } });
      if (paymentMethod === "cash") {
        audit(barista.id, "cash_drawer.opened", "order", orderId, iso(new Date(new Date(createdAt).getTime() + 20 * 1000)), {
          orderNumber, reason: "Cash transaction", metadata: { dispatched: false, hardwareError: "Demo history: no hardware bridge configured" },
        });
      }
      if (customer) db.prepare("UPDATE customers SET credit_balance=credit_balance+?,updated_at=? WHERE id=?").run(subtotal, createdAt, customer.id);
      orderIndex++;
    }
  }

  const ledgerRows = [
    ["salary_payment", money(120), "Weekly salary installment", 1],
    ["deduction", money(15), "Late arrival deduction", 2],
    ["leave", money(0), "Approved day off", 3],
    ["advance", money(40), "Employee advance", 4],
    ["employee_owes", money(12), "Uniform replacement balance", 5],
  ];
  for (const [type, amount, note, daysAgo] of ledgerRows) {
    const date = new Date(now); date.setDate(date.getDate() - daysAgo);
    const effectiveDate = dateOnly(date);
    const ledgerId = id();
    db.prepare(`INSERT INTO staff_ledger (id,user_id,branch_id,type,amount,note,effective_date,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(ledgerId, barista.id, branch.id, type, amount, note, effectiveDate, admin.id, iso(date));
    audit(admin.id, `staff.${type}`, "staff_ledger", ledgerId, iso(date), { newValue: { amount, note, effectiveDate } });
    if (["salary_payment", "advance"].includes(type)) addTreasury(null, type, -amount, "cash", "staff_ledger", ledgerId, note, admin.id, iso(date));
  }
  for (const [category, amount, description, daysAgo] of [
    ["Supplies", money(28), "Milk and takeaway cups", 5],
    ["Maintenance", money(18), "Espresso machine service", 3],
  ]) {
    const date = new Date(now); date.setDate(date.getDate() - daysAgo);
    const expenseId = id();
    db.prepare("INSERT INTO expenses (id,branch_id,category,description,amount,payment_method,user_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(expenseId, branch.id, category, description, amount, "cash", admin.id, iso(date));
    addTreasury(null, "expense", -amount, "cash", "expense", expenseId, description, admin.id, iso(date));
    audit(admin.id, "expense.created", "expense", expenseId, iso(date), { newValue: { amount, category } });
  }
  db.prepare("INSERT INTO runtime_config (key,value,created_at) VALUES ('demo_history_seeded_v1','true',?)").run(timestamp);
  db.exec("COMMIT");
  console.log(JSON.stringify({ seeded: true, days: 7, shifts: shifts.length, orders: orderIndex - 1, barista: barista.id }));
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  db.close();
}
