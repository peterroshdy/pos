import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { permissions } from "@token-taste/shared";

export type SqliteDatabase = DatabaseSync;

const schema = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;

CREATE TABLE IF NOT EXISTS runtime_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branch_pairing_codes (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branch_sync_credentials (
  branch_id TEXT PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
  branch_token_hash TEXT NOT NULL,
  device_token_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  rotated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  receipt_info TEXT NOT NULL DEFAULT '',
  system_branch INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  device_last_seen_at TEXT,
  device_paired_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_role INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY(role_id, permission)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  role_id TEXT REFERENCES roles(id),
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT NOT NULL DEFAULT '',
  employment_start TEXT,
  monthly_salary INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT NOT NULL,
  pin_hash TEXT,
  is_super_admin INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  PRIMARY KEY(user_id, permission)
);

CREATE TABLE IF NOT EXISTS staff_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  type TEXT NOT NULL CHECK(type IN ('advance','deduction','bonus','salary_payment','employee_owes','business_owes','leave')),
  amount INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'Coffee',
  color TEXT NOT NULL DEFAULT '#C9976A',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id),
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT,
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL CHECK(price >= 0),
  cost INTEGER NOT NULL DEFAULT 0 CHECK(cost >= 0),
  stock INTEGER NOT NULL DEFAULT 0,
  low_stock_at INTEGER NOT NULL DEFAULT 5,
  image TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#E9D7C8',
  track_stock INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  price INTEGER NOT NULL CHECK(price >= 0),
  cost INTEGER NOT NULL DEFAULT 0 CHECK(cost >= 0),
  sku TEXT UNIQUE,
  estimated_weight REAL,
  estimated_weight_unit TEXT,
  stock REAL NOT NULL DEFAULT 0,
  low_stock_at REAL NOT NULL DEFAULT 0,
  track_stock INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_branch_availability (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  available INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(product_id, branch_id)
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  unit TEXT NOT NULL CHECK(unit IN ('grams','kilograms','milliliters','liters','pieces')),
  stock_quantity REAL NOT NULL DEFAULT 0,
  low_stock_at REAL NOT NULL DEFAULT 0,
  cost_per_unit INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  UNIQUE(branch_id, sku)
);

CREATE TABLE IF NOT EXISTS recipe_components (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id TEXT REFERENCES product_variants(id) ON DELETE CASCADE,
  inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id),
  quantity REAL NOT NULL CHECK(quantity > 0),
  unit TEXT NOT NULL,
  UNIQUE(product_id, variant_id, inventory_item_id)
);

CREATE TABLE IF NOT EXISTS inventory_item_movements (
  id TEXT PRIMARY KEY,
  inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  type TEXT NOT NULL,
  quantity REAL NOT NULL,
  before_quantity REAL NOT NULL,
  after_quantity REAL NOT NULL,
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_transfers (
  id TEXT PRIMARY KEY,
  source_branch_id TEXT NOT NULL REFERENCES branches(id),
  destination_branch_id TEXT NOT NULL REFERENCES branches(id),
  item_type TEXT NOT NULL CHECK(item_type IN ('product','ingredient')),
  product_id TEXT REFERENCES products(id),
  inventory_item_id TEXT REFERENCES inventory_items(id),
  quantity REAL NOT NULL CHECK(quantity > 0),
  unit TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'dispatched' CHECK(status IN ('dispatched','received','cancelled')),
  reason TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  received_at TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  credit_approved INTEGER NOT NULL DEFAULT 0,
  credit_limit INTEGER NOT NULL DEFAULT 0,
  credit_balance INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  opened_at TEXT NOT NULL,
  opening_cash INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT,
  closing_cash INTEGER,
  expected_cash INTEGER,
  difference INTEGER,
  close_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('open', 'closed'))
);

CREATE TABLE IF NOT EXISTS daily_sequences (
  branch_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  last_number INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(branch_id, business_date)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL UNIQUE,
  order_number TEXT NOT NULL UNIQUE,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  customer_id TEXT REFERENCES customers(id),
  status TEXT NOT NULL CHECK(status IN ('completed', 'voided', 'held')),
  payment_method TEXT NOT NULL CHECK(payment_method IN ('cash', 'card', 'credit')),
  subtotal INTEGER NOT NULL,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  refunded_amount INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  void_reason TEXT,
  business_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS held_orders (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  cart_payload TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  amount INTEGER NOT NULL CHECK(amount > 0),
  reason TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  variant_id TEXT REFERENCES product_variants(id),
  product_name TEXT NOT NULL,
  product_name_ar TEXT NOT NULL,
  variant_name TEXT,
  variant_name_ar TEXT,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  unit_price INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  variant_id TEXT REFERENCES product_variants(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  before_quantity INTEGER NOT NULL,
  after_quantity INTEGER NOT NULL,
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS treasury_movements (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  shift_id TEXT REFERENCES shifts(id),
  type TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  payment_method TEXT NOT NULL,
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  description TEXT NOT NULL,
  attachment TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payment_method TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  order_number TEXT,
  original_value TEXT,
  new_value TEXT,
  reason TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_sync_events (
  event_id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE(branch_id, sequence)
);

CREATE TABLE IF NOT EXISTS sync_inbox (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incoming_transfers (
  id TEXT PRIMARY KEY,
  source_branch_id TEXT NOT NULL,
  destination_branch_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  reason TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_branch_status ON orders(branch_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON sync_outbox(synced_at, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_cloud_events_branch ON cloud_sync_events(branch_id, received_at);
CREATE INDEX IF NOT EXISTS idx_ingredient_movements_created ON inventory_item_movements(created_at);
`;

const now = () => new Date().toISOString();

const categorySeeds = [
  [
    "10000000-0000-4000-8000-000000000001",
    "Coffee",
    "قهوة",
    "Coffee",
    "#8B6657",
  ],
  [
    "10000000-0000-4000-8000-000000000002",
    "Cold Drinks",
    "مشروبات باردة",
    "CupSoda",
    "#89A8A1",
  ],
  ["10000000-0000-4000-8000-000000000003", "Tea", "شاي", "Leaf", "#A8A77A"],
  [
    "10000000-0000-4000-8000-000000000004",
    "Snacks",
    "سناكس",
    "Cookie",
    "#D6A663",
  ],
  [
    "10000000-0000-4000-8000-000000000005",
    "Desserts",
    "حلويات",
    "CakeSlice",
    "#C98C89",
  ],
] as const;

const productSeeds = [
  [
    "20000000-0000-4000-8000-000000000001",
    "10000000-0000-4000-8000-000000000001",
    "COF-001",
    "Turkish Coffee",
    "قهوة تركي",
    4500,
    1500,
    80,
    "☕",
    "#E8D7C9",
  ],
  [
    "20000000-0000-4000-8000-000000000002",
    "10000000-0000-4000-8000-000000000001",
    "COF-002",
    "Espresso",
    "إسبريسو",
    5000,
    1800,
    70,
    "☕",
    "#DCC3B1",
  ],
  [
    "20000000-0000-4000-8000-000000000003",
    "10000000-0000-4000-8000-000000000001",
    "COF-003",
    "Cappuccino",
    "كابتشينو",
    7000,
    2500,
    45,
    "🥛",
    "#EAD8C0",
  ],
  [
    "20000000-0000-4000-8000-000000000004",
    "10000000-0000-4000-8000-000000000001",
    "COF-004",
    "Café Latte",
    "كافيه لاتيه",
    7500,
    2700,
    40,
    "☕",
    "#DFC7AD",
  ],
  [
    "20000000-0000-4000-8000-000000000005",
    "10000000-0000-4000-8000-000000000001",
    "COF-005",
    "Americano",
    "أمريكانو",
    5500,
    1900,
    55,
    "☕",
    "#CAB09A",
  ],
  [
    "20000000-0000-4000-8000-000000000006",
    "10000000-0000-4000-8000-000000000002",
    "CLD-001",
    "Iced Latte",
    "آيس لاتيه",
    8500,
    3200,
    32,
    "🧋",
    "#C9DFDA",
  ],
  [
    "20000000-0000-4000-8000-000000000007",
    "10000000-0000-4000-8000-000000000002",
    "CLD-002",
    "Mint Mojito",
    "موهيتو نعناع",
    8000,
    2800,
    28,
    "🍹",
    "#D8E3C8",
  ],
  [
    "20000000-0000-4000-8000-000000000008",
    "10000000-0000-4000-8000-000000000002",
    "CLD-003",
    "Pepsi",
    "بيبسي",
    3000,
    1900,
    60,
    "🥤",
    "#C6D6E4",
  ],
  [
    "20000000-0000-4000-8000-000000000009",
    "10000000-0000-4000-8000-000000000003",
    "TEA-001",
    "Egyptian Tea",
    "شاي مصري",
    3000,
    900,
    90,
    "🫖",
    "#DDE0C2",
  ],
  [
    "20000000-0000-4000-8000-000000000010",
    "10000000-0000-4000-8000-000000000003",
    "TEA-002",
    "Green Tea",
    "شاي أخضر",
    4000,
    1300,
    36,
    "🍵",
    "#CFD8B7",
  ],
  [
    "20000000-0000-4000-8000-000000000011",
    "10000000-0000-4000-8000-000000000004",
    "SNK-001",
    "Butter Croissant",
    "كرواسون زبدة",
    4500,
    2300,
    18,
    "🥐",
    "#F0D8AE",
  ],
  [
    "20000000-0000-4000-8000-000000000012",
    "10000000-0000-4000-8000-000000000004",
    "SNK-002",
    "Potato Chips",
    "شيبسي",
    2000,
    1300,
    48,
    "🍟",
    "#EBCB8B",
  ],
  [
    "20000000-0000-4000-8000-000000000013",
    "10000000-0000-4000-8000-000000000005",
    "DST-001",
    "Chocolate Cookie",
    "كوكيز شوكولاتة",
    3500,
    1600,
    22,
    "🍪",
    "#D9B5A3",
  ],
  [
    "20000000-0000-4000-8000-000000000014",
    "10000000-0000-4000-8000-000000000005",
    "DST-002",
    "Cheesecake",
    "تشيز كيك",
    6500,
    3200,
    9,
    "🍰",
    "#E8C7C4",
  ],
] as const;

const variantSeeds = [
  [
    "30000000-0000-4000-8000-000000000001",
    "20000000-0000-4000-8000-000000000001",
    "Single",
    "سنجل",
    4500,
    1500,
    "COF-001-S",
    8,
    "grams",
    0,
  ],
  [
    "30000000-0000-4000-8000-000000000002",
    "20000000-0000-4000-8000-000000000001",
    "Double",
    "دبل",
    6000,
    2200,
    "COF-001-D",
    14,
    "grams",
    1,
  ],
] as const;

const ingredientSeeds = [
  [
    "40000000-0000-4000-8000-000000000001",
    "ING-COFFEE",
    "Coffee grounds",
    "بن مطحون",
    "grams",
    25000,
    5000,
    18,
  ],
  [
    "40000000-0000-4000-8000-000000000002",
    "ING-MILK",
    "Fresh milk",
    "حليب طازج",
    "milliliters",
    20000,
    4000,
    4,
  ],
] as const;

const recipeSeeds = [
  [
    "50000000-0000-4000-8000-000000000001",
    "20000000-0000-4000-8000-000000000001",
    "30000000-0000-4000-8000-000000000001",
    "40000000-0000-4000-8000-000000000001",
    8,
    "grams",
  ],
  [
    "50000000-0000-4000-8000-000000000002",
    "20000000-0000-4000-8000-000000000001",
    "30000000-0000-4000-8000-000000000002",
    "40000000-0000-4000-8000-000000000001",
    14,
    "grams",
  ],
  [
    "50000000-0000-4000-8000-000000000003",
    "20000000-0000-4000-8000-000000000003",
    null,
    "40000000-0000-4000-8000-000000000001",
    9,
    "grams",
  ],
  [
    "50000000-0000-4000-8000-000000000004",
    "20000000-0000-4000-8000-000000000003",
    null,
    "40000000-0000-4000-8000-000000000002",
    150,
    "milliliters",
  ],
  [
    "50000000-0000-4000-8000-000000000005",
    "20000000-0000-4000-8000-000000000004",
    null,
    "40000000-0000-4000-8000-000000000001",
    10,
    "grams",
  ],
  [
    "50000000-0000-4000-8000-000000000006",
    "20000000-0000-4000-8000-000000000004",
    null,
    "40000000-0000-4000-8000-000000000002",
    180,
    "milliliters",
  ],
] as const;

function migrateBranchDeviceModel(db: SqliteDatabase) {
  const hasLegacyRegisters = Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='registers'")
      .get(),
  );
  if (!hasLegacyRegisters) return;

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE users_v2 (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL REFERENCES branches(id),
        role_id TEXT REFERENCES roles(id),
        name TEXT NOT NULL,
        name_ar TEXT NOT NULL,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        phone TEXT NOT NULL DEFAULT '',
        employment_start TEXT,
        monthly_salary INTEGER NOT NULL DEFAULT 0,
        password_hash TEXT NOT NULL,
        pin_hash TEXT,
        is_super_admin INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO users_v2
        (id,branch_id,role_id,name,name_ar,username,phone,employment_start,monthly_salary,password_hash,pin_hash,is_super_admin,active,created_at,updated_at)
      SELECT id,branch_id,role_id,
        CASE WHEN is_super_admin=1 THEN 'admin'
             WHEN lower(name) LIKE '%barista%' THEN 'Barista' ELSE name END,
        CASE WHEN is_super_admin=1 THEN 'المدير'
             WHEN lower(name) LIKE '%barista%' THEN 'باريستا' ELSE name_ar END,
        CASE WHEN is_super_admin=1 THEN 'admin'
             WHEN lower(name) LIKE '%barista%' OR lower(email) LIKE 'barista@%' THEN 'Barista'
             ELSE 'legacy-' || substr(replace(id,'-',''),1,12) END,
        phone,employment_start,monthly_salary,password_hash,pin_hash,is_super_admin,active,created_at,updated_at
      FROM users;
      DROP TABLE users;
      ALTER TABLE users_v2 RENAME TO users;

      CREATE TABLE branch_pairing_codes_v2 (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL
      );
      INSERT INTO branch_pairing_codes_v2
        (id,branch_id,code_hash,expires_at,used_at,created_by,created_at)
      SELECT id,branch_id,code_hash,expires_at,used_at,created_by,created_at
      FROM branch_pairing_codes;
      DROP TABLE branch_pairing_codes;
      ALTER TABLE branch_pairing_codes_v2 RENAME TO branch_pairing_codes;

      CREATE TABLE branch_sync_credentials_v2 (
        branch_id TEXT PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
        branch_token_hash TEXT NOT NULL,
        device_token_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        rotated_at TEXT NOT NULL
      );
      INSERT OR REPLACE INTO branch_sync_credentials_v2
        (branch_id,branch_token_hash,device_token_hash,active,created_at,rotated_at)
      SELECT branch_id,branch_token_hash,device_token_hash,active,created_at,rotated_at
      FROM branch_sync_credentials ORDER BY rotated_at;
      DROP TABLE branch_sync_credentials;
      ALTER TABLE branch_sync_credentials_v2 RENAME TO branch_sync_credentials;

      CREATE TABLE shifts_v2 (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL REFERENCES branches(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        opened_at TEXT NOT NULL,
        opening_cash INTEGER NOT NULL DEFAULT 0,
        closed_at TEXT,
        closing_cash INTEGER,
        expected_cash INTEGER,
        difference INTEGER,
        close_note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('open','closed'))
      );
      INSERT INTO shifts_v2
        (id,branch_id,user_id,opened_at,opening_cash,closed_at,closing_cash,expected_cash,difference,close_note,status)
      SELECT id,branch_id,user_id,opened_at,opening_cash,closed_at,closing_cash,expected_cash,difference,close_note,status FROM shifts;
      DROP TABLE shifts;
      ALTER TABLE shifts_v2 RENAME TO shifts;

      CREATE TABLE orders_v2 (
        id TEXT PRIMARY KEY,
        client_request_id TEXT NOT NULL UNIQUE,
        order_number TEXT NOT NULL UNIQUE,
        branch_id TEXT NOT NULL REFERENCES branches(id),
        shift_id TEXT NOT NULL REFERENCES shifts(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        customer_id TEXT REFERENCES customers(id),
        status TEXT NOT NULL CHECK(status IN ('completed','voided','held')),
        payment_method TEXT NOT NULL CHECK(payment_method IN ('cash','card','credit')),
        subtotal INTEGER NOT NULL,
        discount_amount INTEGER NOT NULL DEFAULT 0,
        tax_amount INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL,
        refunded_amount INTEGER NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        void_reason TEXT,
        business_date TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sync_status TEXT NOT NULL DEFAULT 'pending'
      );
      INSERT INTO orders_v2
        (id,client_request_id,order_number,branch_id,shift_id,user_id,customer_id,status,payment_method,subtotal,discount_amount,tax_amount,total,refunded_amount,note,void_reason,business_date,created_at,updated_at,sync_status)
      SELECT id,client_request_id,order_number,branch_id,shift_id,user_id,customer_id,status,payment_method,subtotal,discount_amount,tax_amount,total,refunded_amount,note,void_reason,business_date,created_at,updated_at,sync_status FROM orders;
      DROP TABLE orders;
      ALTER TABLE orders_v2 RENAME TO orders;

      CREATE TABLE held_orders_v2 (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL REFERENCES branches(id),
        shift_id TEXT NOT NULL REFERENCES shifts(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        cart_payload TEXT NOT NULL,
        subtotal INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO held_orders_v2
        (id,branch_id,shift_id,user_id,cart_payload,subtotal,note,created_at,updated_at)
      SELECT id,branch_id,shift_id,user_id,cart_payload,subtotal,note,created_at,updated_at FROM held_orders;
      DROP TABLE held_orders;
      ALTER TABLE held_orders_v2 RENAME TO held_orders;

      CREATE TABLE audit_logs_v2 (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL REFERENCES branches(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        order_number TEXT,
        original_value TEXT,
        new_value TEXT,
        reason TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      INSERT INTO audit_logs_v2
        (id,branch_id,user_id,action,entity_type,entity_id,order_number,original_value,new_value,reason,metadata,created_at)
      SELECT id,branch_id,user_id,action,entity_type,entity_id,order_number,original_value,new_value,reason,metadata,created_at FROM audit_logs;
      DROP TABLE audit_logs;
      ALTER TABLE audit_logs_v2 RENAME TO audit_logs;

      CREATE TABLE cloud_sync_events_v2 (
        event_id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        received_at TEXT NOT NULL,
        UNIQUE(branch_id,sequence)
      );
      INSERT OR IGNORE INTO cloud_sync_events_v2
        (event_id,branch_id,sequence,aggregate_type,aggregate_id,event_type,occurred_at,payload,received_at)
      SELECT event_id,branch_id,sequence,aggregate_type,aggregate_id,event_type,occurred_at,payload,received_at FROM cloud_sync_events ORDER BY received_at;
      DROP TABLE cloud_sync_events;
      ALTER TABLE cloud_sync_events_v2 RENAME TO cloud_sync_events;

      UPDATE branches SET
        device_last_seen_at=(SELECT MAX(last_seen_at) FROM registers WHERE registers.branch_id=branches.id),
        device_paired_at=COALESCE(device_paired_at,(SELECT MAX(rotated_at) FROM branch_sync_credentials WHERE branch_sync_credentials.branch_id=branches.id));
      DROP TABLE registers;
      CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
      CREATE INDEX IF NOT EXISTS idx_orders_branch_status ON orders(branch_id,status);
      CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_cloud_events_branch ON cloud_sync_events(branch_id,received_at);
      COMMIT;`);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The migration may have failed before opening the transaction.
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

export function createDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(schema);
  const orderColumns = db
    .prepare("PRAGMA table_info(orders)")
    .all() as unknown as Array<{ name: string }>;
  if (!orderColumns.some((column) => column.name === "business_date")) {
    db.exec(
      "ALTER TABLE orders ADD COLUMN business_date TEXT NOT NULL DEFAULT ''",
    );
    db.exec(
      "UPDATE orders SET business_date = substr(created_at, 1, 10) WHERE business_date = ''",
    );
  }
  if (!orderColumns.some((column) => column.name === "refunded_amount")) {
    db.exec(
      "ALTER TABLE orders ADD COLUMN refunded_amount INTEGER NOT NULL DEFAULT 0",
    );
  }
  const orderItemColumns = db
    .prepare("PRAGMA table_info(order_items)")
    .all() as unknown as Array<{ name: string }>;
  if (!orderItemColumns.some((column) => column.name === "variant_id")) {
    db.exec(
      "ALTER TABLE order_items ADD COLUMN variant_id TEXT REFERENCES product_variants(id)",
    );
    db.exec("ALTER TABLE order_items ADD COLUMN variant_name TEXT");
    db.exec("ALTER TABLE order_items ADD COLUMN variant_name_ar TEXT");
  }
  if (!orderItemColumns.some((column) => column.name === "unit_cost")) {
    db.exec(
      "ALTER TABLE order_items ADD COLUMN unit_cost INTEGER NOT NULL DEFAULT 0",
    );
    db.exec(`UPDATE order_items SET unit_cost = COALESCE(
      (SELECT pv.cost FROM product_variants pv WHERE pv.id = order_items.variant_id),
      (SELECT p.cost FROM products p WHERE p.id = order_items.product_id), 0)`);
  }
  const productColumns = db
    .prepare("PRAGMA table_info(products)")
    .all() as unknown as Array<{ name: string }>;
  if (!productColumns.some((column) => column.name === "barcode")) {
    db.exec("ALTER TABLE products ADD COLUMN barcode TEXT");
    db.exec(
      "ALTER TABLE products ADD COLUMN description TEXT NOT NULL DEFAULT ''",
    );
    db.exec("ALTER TABLE products ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
  }
  const variantColumns = db
    .prepare("PRAGMA table_info(product_variants)")
    .all() as unknown as Array<{ name: string }>;
  if (!variantColumns.some((column) => column.name === "stock")) {
    db.exec(
      "ALTER TABLE product_variants ADD COLUMN stock REAL NOT NULL DEFAULT 0",
    );
    db.exec(
      "ALTER TABLE product_variants ADD COLUMN low_stock_at REAL NOT NULL DEFAULT 0",
    );
    db.exec(
      "ALTER TABLE product_variants ADD COLUMN track_stock INTEGER NOT NULL DEFAULT 0",
    );
  }
  const inventoryMovementColumns = db
    .prepare("PRAGMA table_info(inventory_movements)")
    .all() as unknown as Array<{ name: string }>;
  if (!inventoryMovementColumns.some((column) => column.name === "variant_id"))
    db.exec(
      "ALTER TABLE inventory_movements ADD COLUMN variant_id TEXT REFERENCES product_variants(id)",
    );
  const userColumns = db
    .prepare("PRAGMA table_info(users)")
    .all() as unknown as Array<{ name: string }>;
  if (!userColumns.some((column) => column.name === "phone")) {
    db.exec("ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT ''");
    db.exec("ALTER TABLE users ADD COLUMN employment_start TEXT");
    db.exec(
      "ALTER TABLE users ADD COLUMN monthly_salary INTEGER NOT NULL DEFAULT 0",
    );
  }
  const customerColumns = db
    .prepare("PRAGMA table_info(customers)")
    .all() as unknown as Array<{ name: string }>;
  if (!customerColumns.some((column) => column.name === "notes"))
    db.exec("ALTER TABLE customers ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
  const branchColumns = db
    .prepare("PRAGMA table_info(branches)")
    .all() as unknown as Array<{ name: string }>;
  if (!branchColumns.some((column) => column.name === "phone")) {
    db.exec("ALTER TABLE branches ADD COLUMN phone TEXT NOT NULL DEFAULT ''");
    db.exec("ALTER TABLE branches ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
    db.exec(
      "ALTER TABLE branches ADD COLUMN receipt_info TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!branchColumns.some((column) => column.name === "system_branch"))
    db.exec(
      "ALTER TABLE branches ADD COLUMN system_branch INTEGER NOT NULL DEFAULT 0",
    );
  if (!branchColumns.some((column) => column.name === "device_last_seen_at"))
    db.exec("ALTER TABLE branches ADD COLUMN device_last_seen_at TEXT");
  if (!branchColumns.some((column) => column.name === "device_paired_at"))
    db.exec("ALTER TABLE branches ADD COLUMN device_paired_at TEXT");
  const treasuryColumns = db
    .prepare("PRAGMA table_info(treasury_movements)")
    .all() as unknown as Array<{ name: string }>;
  if (!treasuryColumns.some((column) => column.name === "category")) {
    db.exec(
      "ALTER TABLE treasury_movements ADD COLUMN category TEXT NOT NULL DEFAULT ''",
    );
    db.exec(
      "ALTER TABLE treasury_movements ADD COLUMN attachment TEXT NOT NULL DEFAULT ''",
    );
  }
  migrateBranchDeviceModel(db);
  seed(db);
  return db;
}

export function getOrCreateRuntimeValue(
  db: SqliteDatabase,
  key: string,
  createValue: () => string,
) {
  const existing = db
    .prepare("SELECT value FROM runtime_config WHERE key = ?")
    .get(key) as { value: string } | undefined;
  if (existing) return existing.value;
  const value = createValue();
  db.prepare(
    "INSERT OR IGNORE INTO runtime_config (key, value, created_at) VALUES (?, ?, ?)",
  ).run(key, value, now());
  return (
    db.prepare("SELECT value FROM runtime_config WHERE key = ?").get(key) as {
      value: string;
    }
  ).value;
}

export function getRuntimeValue(db: SqliteDatabase, key: string) {
  return (
    db.prepare("SELECT value FROM runtime_config WHERE key = ?").get(key) as
      | { value: string }
      | undefined
  )?.value;
}

export function setRuntimeValue(
  db: SqliteDatabase,
  key: string,
  value: string,
) {
  db.prepare(
    `INSERT INTO runtime_config (key, value, created_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(key, value, now());
}

export function inTransaction<T>(db: SqliteDatabase, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function seed(db: SqliteDatabase) {
  const timestamp = now();
  const configuredBranchId = process.env.BRANCH_ID?.trim() || undefined;
  const existingBranch = db
    .prepare("SELECT id, code FROM branches ORDER BY created_at LIMIT 1")
    .get() as { id: string; code: string } | undefined;
  const branchId =
    configuredBranchId ??
    existingBranch?.id ??
    `LOCAL-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
  const branchCode =
    existingBranch?.code ??
    (configuredBranchId
      ? `SYS${randomUUID().replaceAll("-", "").slice(0, 5).toUpperCase()}`
      : `SETUP${branchId.slice(-3)}`);
  const cloudServer = process.env.CLOUD_RECEIVER_ENABLED === "true";
  process.env.BRANCH_ID = branchId;
  if (!existingBranch)
    setRuntimeValue(
      db,
      "setup_provisional_identity",
      configuredBranchId ? "false" : "true",
    );
  const roleId = "role-owner";
  const baristaRoleId = "role-barista";
  const ownerId = "user-owner";
  const baristaId = "user-barista";

  db.prepare(
    "INSERT OR IGNORE INTO branches (id, code, name, name_ar, address, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    branchId,
    branchCode,
    cloudServer ? "Cloud Administration" : "Pending cloud pairing",
    cloudServer ? "إدارة السحابة" : "في انتظار ربط الفرع",
    "",
    timestamp,
  );
  if (cloudServer || !configuredBranchId)
    db.prepare("UPDATE branches SET system_branch=1 WHERE id=?").run(branchId);
  db.prepare(
    "INSERT OR IGNORE INTO roles (id, name, name_ar, description, system_role, created_at) VALUES (?, ?, ?, ?, 1, ?)",
  ).run(roleId, "Admin", "المدير", "Full administration access", timestamp);
  db.prepare(
    "INSERT OR IGNORE INTO roles (id, name, name_ar, description, system_role, created_at) VALUES (?, ?, ?, ?, 0, ?)",
  ).run(
    baristaRoleId,
    "Barista",
    "باريستا",
    "Create and complete orders only",
    timestamp,
  );
  const effectiveBaristaRoleId = (
    db
      .prepare(
        "SELECT id FROM roles WHERE id=? OR name=? COLLATE NOCASE ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1",
      )
      .get(baristaRoleId, "Barista", baristaRoleId) as { id: string }
  ).id;
  db.prepare(
    "UPDATE roles SET name='Admin',name_ar='المدير',description='Full administration access' WHERE id=?",
  ).run(roleId);
  db.prepare(
    "UPDATE roles SET name='Barista',name_ar='باريستا',description='Create and complete orders only' WHERE id=?",
  ).run(effectiveBaristaRoleId);
  const permissionInsert = db.prepare(
    "INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)",
  );
  if (getRuntimeValue(db, "permission_model_v2_seeded") !== "true") {
    db.prepare("DELETE FROM role_permissions WHERE role_id IN (?,?)").run(
      roleId,
      effectiveBaristaRoleId,
    );
    for (const permission of permissions.filter(
      (permission) =>
        !["pos.access", "pos.drawer", "pos.discount"].includes(permission),
    ))
      permissionInsert.run(roleId, permission);
    for (const permission of ["pos.access", "pos.drawer", "pos.history", "pos.shift", "pos.reprint"])
      permissionInsert.run(effectiveBaristaRoleId, permission);
    setRuntimeValue(db, "permission_model_v2_seeded", "true");
  }
  // Keep operational shift controls available to the POS user without granting
  // the broader administrative shifts.manage permission.
  permissionInsert.run(effectiveBaristaRoleId, "pos.history");
  permissionInsert.run(effectiveBaristaRoleId, "pos.shift");

  const existingOwner = db
    .prepare("SELECT id FROM users WHERE id = ?")
    .get(ownerId);
  const suppliedPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD?.trim();
  if (!existingOwner && suppliedPassword) {
    const passwordHash = bcrypt.hashSync(suppliedPassword, 12);
    const pinHash = process.env.BOOTSTRAP_ADMIN_PIN
      ? bcrypt.hashSync(process.env.BOOTSTRAP_ADMIN_PIN, 12)
      : null;
    db.prepare(
      `INSERT INTO users
      (id, branch_id, role_id, name, name_ar, username, password_hash, pin_hash, is_super_admin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      ownerId,
      branchId,
      roleId,
      "admin",
      "المدير",
      "admin",
      passwordHash,
      pinHash,
      timestamp,
      timestamp,
    );
  }
  const existingBarista = db
    .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
    .get("Barista") as { id: string } | undefined;
  if (!existingBarista && suppliedPassword) {
    const baristaPassword =
      process.env.BOOTSTRAP_BARISTA_PASSWORD?.trim() ||
      "Barista-demo#2026!B4r";
    db.prepare(
      `INSERT INTO users
      (id, branch_id, role_id, name, name_ar, username, password_hash, is_super_admin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      baristaId,
      branchId,
      effectiveBaristaRoleId,
      "Barista",
      "باريستا",
      "Barista",
      bcrypt.hashSync(baristaPassword, 12),
      timestamp,
      timestamp,
    );
  }
  db.prepare(
    "UPDATE users SET name='admin',name_ar='المدير',username='admin',role_id=? WHERE id=?",
  ).run(roleId, ownerId);
  db.prepare(
    "UPDATE users SET name='Barista',name_ar='باريستا',username='Barista',role_id=?,is_super_admin=0 WHERE id=?",
  ).run(effectiveBaristaRoleId, existingBarista?.id ?? baristaId);
  db.prepare(
    "UPDATE users SET active=0 WHERE id NOT IN (?,?) AND username LIKE 'legacy-%'",
  ).run(ownerId, existingBarista?.id ?? baristaId);
  db.prepare(
    `UPDATE branches SET name='City Stars Branch',name_ar='فرع سيتي ستارز',
       code=CASE WHEN code='TEST 2' THEN 'CITYSTARS' ELSE code END
     WHERE system_branch=0 AND (lower(name) IN ('downtown branch','downtown','test 2','test2') OR code='TEST 2')`,
  ).run();
  db.prepare(
    "UPDATE branches SET name='Cloud Administration',name_ar='إدارة السحابة' WHERE system_branch=1",
  ).run();
  if (cloudServer) {
    const testingBranch = db
      .prepare(
        "SELECT id FROM branches WHERE system_branch=0 AND active=1 ORDER BY CASE WHEN name='City Stars Branch' THEN 0 ELSE 1 END,created_at LIMIT 1",
      )
      .get() as { id: string } | undefined;
    if (testingBranch)
      db.prepare(
        "UPDATE users SET branch_id=? WHERE username IN ('admin','Barista')",
      ).run(testingBranch.id);
  }

  const categoryInsert = db.prepare(`INSERT OR IGNORE INTO categories
    (id, name, name_ar, icon, color, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  categorySeeds.forEach((category, index) =>
    categoryInsert.run(...category, index, timestamp),
  );

  const productInsert = db.prepare(`INSERT OR IGNORE INTO products
    (id, category_id, sku, name, name_ar, price, cost, stock, image, color, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  productSeeds.forEach((product) => productInsert.run(...product, timestamp));

  const variantInsert = db.prepare(`INSERT OR IGNORE INTO product_variants
    (id, product_id, name, name_ar, price, cost, sku, estimated_weight, estimated_weight_unit, sort_order, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  variantSeeds.forEach((variant) => variantInsert.run(...variant, timestamp));

  const ingredientInsert = db.prepare(`INSERT OR IGNORE INTO inventory_items
    (id, branch_id, sku, name, name_ar, unit, stock_quantity, low_stock_at, cost_per_unit, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ingredientSeeds.forEach((ingredient) =>
    ingredientInsert.run(
      ingredient[0],
      branchId,
      ...ingredient.slice(1),
      timestamp,
    ),
  );

  const recipeInsert = db.prepare(`INSERT OR IGNORE INTO recipe_components
    (id, product_id, variant_id, inventory_item_id, quantity, unit) VALUES (?, ?, ?, ?, ?, ?)`);
  recipeSeeds.forEach((recipe) => recipeInsert.run(...recipe));

  const settingInsert = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
  );
  settingInsert.run(
    "tax",
    JSON.stringify({ enabled: false, rate: 0, pricesIncludeTax: true }),
    timestamp,
  );
  settingInsert.run(
    "brand",
    JSON.stringify({ name: "Talk & TASTE", currency: "EGP", language: "en" }),
    timestamp,
  );
  settingInsert.run(
    "receipt",
    JSON.stringify({
      footer: "Thank you for visiting Talk & TASTE",
      autoPrint: false,
      bilingual: true,
      showBranch: true,
      drawerTrigger: "printer",
    }),
    timestamp,
  );

  db.prepare(
    "UPDATE settings SET value = replace(replace(replace(value, 'Token Taste', 'Talk & TASTE'), 'Talk and TASTE', 'Talk & TASTE'), 'Test & Coffee', 'Talk & TASTE'), updated_at = ? WHERE key IN ('brand', 'receipt')",
  ).run(timestamp);

  const seededOwner = db
    .prepare("SELECT id FROM users WHERE id = ?")
    .get(ownerId);
  const openShift = db
    .prepare("SELECT id FROM shifts WHERE branch_id = ? AND status = 'open'")
    .get(branchId) as { id: string } | undefined;
  if (seededOwner && !openShift) {
    db.prepare(
      `INSERT INTO shifts (id, branch_id, user_id, opened_at, opening_cash, status)
      VALUES (?, ?, ?, ?, 0, 'open')`,
    ).run(randomUUID(), branchId, ownerId, timestamp);
  }
}

export function insertAudit(
  db: SqliteDatabase,
  input: {
    branchId: string;
    userId: string;
    action: string;
    entityType: string;
    entityId: string;
    orderNumber?: string | null;
    originalValue?: unknown;
    newValue?: unknown;
    reason?: string | null;
    metadata?: unknown;
  },
) {
  const auditId = randomUUID();
  const timestamp = now();
  const originalValue =
    input.originalValue === undefined
      ? null
      : JSON.stringify(input.originalValue);
  const newValue =
    input.newValue === undefined ? null : JSON.stringify(input.newValue);
  const metadata = JSON.stringify(input.metadata ?? {});
  db.prepare(
    `INSERT INTO audit_logs
    (id, branch_id, user_id, action, entity_type, entity_id, order_number, original_value, new_value, reason, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    auditId,
    input.branchId,
    input.userId,
    input.action,
    input.entityType,
    input.entityId,
    input.orderNumber ?? null,
    originalValue,
    newValue,
    input.reason ?? null,
    metadata,
    timestamp,
  );
  db.prepare(
    `INSERT INTO sync_outbox
    (id, branch_id, aggregate_type, aggregate_id, event_type, payload, next_attempt_at, created_at)
    VALUES (?, ?, 'audit_log', ?, 'audit.recorded', ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.branchId,
    auditId,
    JSON.stringify({
      id: auditId,
      branchId: input.branchId,
      userId: input.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      orderNumber: input.orderNumber ?? null,
      originalValue: input.originalValue ?? null,
      newValue: input.newValue ?? null,
      reason: input.reason ?? null,
      metadata: input.metadata ?? {},
      timestamp,
    }),
    timestamp,
    timestamp,
  );
}

export function enqueueSync(
  db: SqliteDatabase,
  branchId: string,
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: unknown,
) {
  const timestamp = now();
  db.prepare(
    `INSERT INTO sync_outbox
    (id, branch_id, aggregate_type, aggregate_id, event_type, payload, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    branchId,
    aggregateType,
    aggregateId,
    eventType,
    JSON.stringify(payload),
    timestamp,
    timestamp,
  );
}

export function rowBoolean<T extends Record<string, unknown>>(
  row: T,
  keys: (keyof T)[],
): T {
  for (const key of keys) row[key] = Boolean(row[key]) as T[keyof T];
  return row;
}
