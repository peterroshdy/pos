import "dotenv/config";
import Fastify, { type FastifyError, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import bcrypt from "bcryptjs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  checkoutSchema,
  permissions,
  type Permission,
} from "@token-taste/shared";
import {
  createDatabase,
  enqueueSync,
  getOrCreateRuntimeValue,
  getRuntimeValue,
  insertAudit,
  inTransaction,
  rowBoolean,
  setRuntimeValue,
} from "./database.js";
import { startSyncWorker } from "./sync-worker.js";

const isProduction = process.env.NODE_ENV === "production";
const cloudServer = process.env.CLOUD_RECEIVER_ENABLED === "true";
const businessTimezone = process.env.BUSINESS_TIMEZONE ?? "Africa/Cairo";
const currentBusinessDate = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: businessTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const startedAt = Date.now();
const db = createDatabase(
  process.env.DATABASE_PATH ?? resolve(process.cwd(), "data/token-taste.db"),
);
let localBranchId = String(process.env.BRANCH_ID);
const configuredJwtSecret = process.env.JWT_SECRET?.trim() || undefined;
if (configuredJwtSecret && configuredJwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters when supplied");
}
const jwtSecret =
  configuredJwtSecret ??
  getOrCreateRuntimeValue(db, "jwt_secret", () =>
    randomBytes(48).toString("base64url"),
  );
const app = Fastify({ logger: true, trustProxy: isProduction });

await app.register(helmet, { contentSecurityPolicy: false });
await app.register(cors, {
  origin: isProduction ? false : [/^http:\/\/localhost:\d+$/],
  credentials: true,
});
await app.register(rateLimit, { max: 250, timeWindow: "1 minute" });
await app.register(jwt, {
  secret: jwtSecret,
});

const authenticate = async (request: FastifyRequest) => {
  await request.jwtVerify();
  refreshRequestAccess(request);
};
const requirePermission =
  (permission: Permission) => async (request: FastifyRequest) => {
    await request.jwtVerify();
    refreshRequestAccess(request);
    if (!request.user.permissions.includes(permission)) {
      throw Object.assign(new Error("Permission denied"), { statusCode: 403 });
    }
  };
const requireAnyPermission =
  (...required: Permission[]) =>
  async (request: FastifyRequest) => {
    await request.jwtVerify();
    refreshRequestAccess(request);
    if (!required.some((permission) =>
      request.user.permissions.includes(permission),
    )) {
      throw Object.assign(new Error("Permission denied"), { statusCode: 403 });
    }
  };

const userPermissions = (
  userId: string,
  roleId: string | null,
): Permission[] => {
  const granted = new Set<string>();
  if (roleId) {
    const rows = db
      .prepare("SELECT permission FROM role_permissions WHERE role_id = ?")
      .all(roleId) as Array<{ permission: string }>;
    rows.forEach((row) => granted.add(row.permission));
  }
  const overrides = db
    .prepare(
      "SELECT permission, allowed FROM user_permissions WHERE user_id = ?",
    )
    .all(userId) as Array<{ permission: string; allowed: number }>;
  overrides.forEach((row) =>
    row.allowed ? granted.add(row.permission) : granted.delete(row.permission),
  );
  return permissions.filter((permission) => granted.has(permission));
};
const sessionLocation = (branchId: string) => {
  const branch = db
    .prepare("SELECT name,name_ar FROM branches WHERE id=?")
    .get(branchId) as { name: string; name_ar: string };
  return {
    branchName: branch.name,
    branchNameAr: branch.name_ar,
  };
};

const refreshRequestAccess = (request: FastifyRequest) => {
  const user = db
    .prepare(
      "SELECT branch_id,role_id,name,name_ar,is_super_admin,active FROM users WHERE id=?",
    )
    .get(request.user.sub) as Record<string, unknown> | undefined;
  if (!user?.active)
    throw Object.assign(new Error("Session user is disabled"), {
      statusCode: 401,
    });
  request.user.branchId = String(user.branch_id);
  request.user.name = String(user.name);
  request.user.nameAr = String(user.name_ar);
  request.user.isSuperAdmin = Boolean(user.is_super_admin);
  request.user.permissions = userPermissions(
    request.user.sub,
    user.role_id ? String(user.role_id) : null,
  );
};

app.setErrorHandler((error: FastifyError, _request, reply) => {
  const statusCode =
    "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
  if (statusCode >= 500) app.log.error(error);
  reply.status(statusCode).send({
    error: statusCode >= 500 ? "Internal server error" : error.message,
  });
});

app.get("/api/health", async () => {
  db.prepare("SELECT 1").get();
  return {
    status: "ok",
    database: "connected",
    mode: cloudServer ? "cloud" : "branch",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    ...(cloudServer ? {} : { branchId: localBranchId }),
    timestamp: new Date().toISOString(),
  };
});

const cloudBranchTokens = (() => {
  try {
    return JSON.parse(process.env.CLOUD_BRANCH_TOKENS ?? "{}") as Record<
      string,
      string
    >;
  } catch {
    throw new Error(
      "CLOUD_BRANCH_TOKENS must be a JSON object keyed by branch ID",
    );
  }
})();
const cloudDeviceTokens = (() => {
  try {
    return JSON.parse(process.env.CLOUD_DEVICE_TOKENS ?? "{}") as Record<
      string,
      string
    >;
  } catch {
    throw new Error(
      "CLOUD_DEVICE_TOKENS must be a JSON object keyed by branch ID",
    );
  }
})();
const secureTokenMatch = (received: string, expected: string) => {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};
const tokenDigest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const validSyncCredentials = (
  branchId: string,
  branchToken: string,
  deviceToken: string,
) => {
  const expected = cloudBranchTokens[branchId];
  const expectedDevice = cloudDeviceTokens[branchId];
  if (
    expected &&
    branchToken &&
    secureTokenMatch(branchToken, expected) &&
    (!expectedDevice ||
      (deviceToken && secureTokenMatch(deviceToken, expectedDevice)))
  )
    return true;
  const dynamic = db
    .prepare(
      `SELECT branch_token_hash,device_token_hash FROM branch_sync_credentials
       WHERE branch_id=? AND active=1`,
    )
    .get(branchId) as
    | { branch_token_hash: string; device_token_hash: string }
    | undefined;
  return Boolean(
    dynamic &&
      branchToken &&
      deviceToken &&
      secureTokenMatch(tokenDigest(branchToken), dynamic.branch_token_hash) &&
      secureTokenMatch(tokenDigest(deviceToken), dynamic.device_token_hash),
  );
};

app.post("/api/sync/events", async (request, reply) => {
  if (process.env.CLOUD_RECEIVER_ENABLED !== "true")
    return reply.status(404).send({ error: "Not found" });
  const branchId = String(request.headers["x-branch-id"] ?? "");
  const token = String(request.headers.authorization ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  const deviceToken = String(request.headers["x-device-token"] ?? "");
  if (!branchId || !validSyncCredentials(branchId, token, deviceToken))
    return reply.status(401).send({ error: "Invalid branch credentials" });
  db.prepare("UPDATE branches SET device_last_seen_at=? WHERE id=?").run(
    new Date().toISOString(), branchId,
  );
  const body = request.body as {
    eventId?: string;
    branchId?: string;
    sequence?: number;
    aggregateType?: string;
    aggregateId?: string;
    eventType?: string;
    occurredAt?: string;
    payload?: unknown;
  };
  if (
    body.branchId !== branchId ||
    !body.eventId ||
    !Number.isInteger(body.sequence) ||
    Number(body.sequence) <= 0 ||
    !body.aggregateType ||
    !body.aggregateId ||
    !body.eventType ||
    !body.occurredAt
  ) {
    return reply.status(400).send({ error: "Invalid synchronization event" });
  }
  const existing = db
    .prepare("SELECT event_id FROM cloud_sync_events WHERE event_id = ?")
    .get(body.eventId);
  if (existing)
    return { accepted: true, duplicate: true, eventId: body.eventId };
  try {
    db.prepare(
      `INSERT INTO cloud_sync_events (event_id,branch_id,sequence,aggregate_type,aggregate_id,event_type,occurred_at,payload,received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      body.eventId,
      branchId,
      Number(body.sequence),
      body.aggregateType,
      body.aggregateId,
      body.eventType,
      body.occurredAt,
      JSON.stringify(body.payload ?? {}),
      new Date().toISOString(),
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE"))
      return reply
        .status(409)
        .send({ error: "Sequence conflict for this branch" });
    throw error;
  }
  return reply
    .status(202)
    .send({ accepted: true, duplicate: false, eventId: body.eventId });
});

app.get("/api/sync/inbox", async (request, reply) => {
  if (process.env.CLOUD_RECEIVER_ENABLED !== "true")
    return reply.status(404).send({ error: "Not found" });
  const branchId = String(request.headers["x-branch-id"] ?? "");
  const token = String(request.headers.authorization ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  const deviceToken = String(request.headers["x-device-token"] ?? "");
  if (!branchId || !validSyncCredentials(branchId, token, deviceToken))
    return reply.status(401).send({ error: "Invalid branch credentials" });
  db.prepare("UPDATE branches SET device_last_seen_at=? WHERE id=?").run(
    new Date().toISOString(), branchId,
  );
  const after = Math.max(
    0,
    Number((request.query as { after?: string }).after ?? 0) || 0,
  );
  const rows = db
    .prepare(
      `SELECT rowid AS cursor,event_id,event_type,payload,received_at FROM cloud_sync_events
    WHERE rowid>? AND (
      (event_type='inventory.transfer_dispatched' AND json_extract(payload,'$.destinationBranchId')=?) OR
      (event_type='inventory.transfer_received' AND json_extract(payload,'$.sourceBranchId')=?)
    ) ORDER BY rowid LIMIT 100`,
    )
    .all(after, branchId, branchId) as unknown as Array<{
    cursor: number;
    event_id: string;
    event_type: string;
    payload: string;
    received_at: string;
  }>;
  return {
    events: rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
    cursor: rows.at(-1)?.cursor ?? after,
  };
});

app.post(
  "/api/enroll",
  { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
  async (request, reply) => {
    if (process.env.CLOUD_RECEIVER_ENABLED !== "true")
      return reply.status(404).send({ error: "Not found" });
    const submitted = String(
      (request.body as { pairingCode?: string }).pairingCode ?? "",
    )
      .replace(/[^a-fA-F0-9]/g, "")
      .toUpperCase();
    if (submitted.length !== 16)
      return reply.status(400).send({ error: "Enter a valid pairing code" });
    const pairing = db
      .prepare(
        `SELECT pc.id,pc.branch_id,pc.expires_at,pc.used_at,pc.created_by,
                b.code,b.name,b.name_ar,b.address,b.phone,b.receipt_info,b.active
         FROM branch_pairing_codes pc
         JOIN branches b ON b.id=pc.branch_id
         WHERE pc.code_hash=?`,
      )
      .get(tokenDigest(submitted)) as Record<string, unknown> | undefined;
    if (!pairing)
      return reply.status(401).send({ error: "Pairing code is invalid" });
    if (pairing.used_at)
      return reply.status(409).send({ error: "Pairing code was already used" });
    if (new Date(String(pairing.expires_at)).getTime() <= Date.now())
      return reply.status(410).send({ error: "Pairing code expired" });
    if (!pairing.active)
      return reply.status(403).send({ error: "Branch is disabled" });

    const branchToken = randomBytes(32).toString("base64url");
    const deviceToken = randomBytes(32).toString("base64url");
    const timestamp = new Date().toISOString();
    inTransaction(db, () => {
      const claimed = db
        .prepare(
          "UPDATE branch_pairing_codes SET used_at=? WHERE id=? AND used_at IS NULL",
        )
        .run(timestamp, String(pairing.id));
      if (claimed.changes !== 1) throw new Error("Pairing code was already used");
      db.prepare(
        `INSERT INTO branch_sync_credentials
         (branch_id,branch_token_hash,device_token_hash,active,created_at,rotated_at)
         VALUES (?,?,?,1,?,?)
         ON CONFLICT(branch_id) DO UPDATE SET
           branch_token_hash=excluded.branch_token_hash,
           device_token_hash=excluded.device_token_hash,
           active=1,
           rotated_at=excluded.rotated_at`,
      ).run(
        String(pairing.branch_id),
        tokenDigest(branchToken),
        tokenDigest(deviceToken),
        timestamp,
        timestamp,
      );
      db.prepare(
        "UPDATE branches SET device_last_seen_at=?,device_paired_at=? WHERE id=?",
      ).run(timestamp, timestamp, String(pairing.branch_id));
      insertAudit(db, {
        branchId: String(pairing.branch_id),
        userId: String(pairing.created_by),
        action: "branch.paired",
        entityType: "branch",
        entityId: String(pairing.branch_id),
      });
    });
    return {
      branch: {
        id: pairing.branch_id,
        code: pairing.code,
        name: pairing.name,
        nameAr: pairing.name_ar,
        address: pairing.address,
        phone: pairing.phone,
        receiptInfo: pairing.receipt_info,
      },
      branchToken,
      deviceToken,
    };
  },
);

const ownerExists = () =>
  Boolean(
    db
      .prepare("SELECT id FROM users WHERE is_super_admin = 1 LIMIT 1")
      .get(),
  );
const pairedWithCloud = () =>
  cloudServer || getRuntimeValue(db, "cloud_pairing_complete") === "true";
const enrollmentBaseUrl = () =>
  (process.env.CLOUD_ENROLLMENT_URL ?? "https://157.173.194.66").replace(
    /\/$/,
    "",
  );

type Enrollment = {
  branch: {
    id: string;
    code: string;
    name: string;
    nameAr: string;
    address: string;
    phone: string;
    receiptInfo: string;
  };
  branchToken: string;
  deviceToken: string;
};

const pairLocalInstallation = async (pairingCode: string) => {
  if (pairedWithCloud())
    throw Object.assign(new Error("This installation is already paired"), {
      statusCode: 409,
    });
  const cloudUrl = enrollmentBaseUrl();
  const parsed = new URL(cloudUrl);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (isProduction && parsed.protocol !== "https:" && !loopback)
    throw Object.assign(new Error("The cloud pairing endpoint must use HTTPS"), {
      statusCode: 400,
    });
  const response = await fetch(`${cloudUrl}/api/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairingCode }),
    signal: AbortSignal.timeout(15_000),
  });
  const result = (await response.json().catch(() => ({}))) as Enrollment & {
    error?: string;
  };
  if (!response.ok)
    throw Object.assign(
      new Error(result.error ?? "Cloud branch pairing failed"),
      { statusCode: response.status },
    );
  if (
    !result.branch?.id ||
    !result.branchToken ||
    !result.deviceToken
  )
    throw new Error("Cloud returned an incomplete branch identity");
  const previousBranchId = localBranchId;
  inTransaction(db, () => {
    if (result.branch.id !== previousBranchId) {
      db.prepare(
        `INSERT INTO branches
         (id,code,name,name_ar,address,phone,receipt_info,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        result.branch.id,
        result.branch.code,
        result.branch.name,
        result.branch.nameAr,
        result.branch.address ?? "",
        result.branch.phone ?? "",
        result.branch.receiptInfo ?? "",
        new Date().toISOString(),
      );
    }
    // A branch may run offline for any length of time before it is paired. Move
    // every local reference to the cloud-owned identity in one transaction so
    // the complete history is uploaded under the correct branch.
    const branchTables = [
      "users",
      "staff_ledger",
      "product_branch_availability",
      "inventory_items",
      "inventory_item_movements",
      "shifts",
      "daily_sequences",
      "orders",
      "held_orders",
      "refunds",
      "inventory_movements",
      "treasury_movements",
      "expenses",
      "audit_logs",
      "sync_outbox",
    ];
    for (const table of branchTables)
      db.prepare(`UPDATE ${table} SET branch_id=? WHERE branch_id=?`).run(
        result.branch.id,
        previousBranchId,
      );
    for (const column of ["source_branch_id", "destination_branch_id"])
      db.prepare(
        `UPDATE inventory_transfers SET ${column}=? WHERE ${column}=?`,
      ).run(result.branch.id, previousBranchId);
    for (const column of ["source_branch_id", "destination_branch_id"])
      db.prepare(
        `UPDATE incoming_transfers SET ${column}=? WHERE ${column}=?`,
      ).run(result.branch.id, previousBranchId);

    // IDs are also embedded inside queued JSON event bodies. Rewriting the
    // exact generated IDs is safe and keeps historical event payloads aligned.
    db.prepare(
      `UPDATE sync_outbox
       SET payload=replace(payload, ?, ?),
           attempts=0, next_attempt_at=?, synced_at=NULL, last_error=NULL`,
    ).run(
      previousBranchId,
      result.branch.id,
      new Date().toISOString(),
    );
    for (const column of ["original_value", "new_value", "metadata"])
      db.prepare(
        `UPDATE audit_logs SET ${column}=replace(${column}, ?, ?)
         WHERE ${column} IS NOT NULL`,
      ).run(
        previousBranchId,
        result.branch.id,
      );
    if (previousBranchId !== result.branch.id)
      db.prepare("DELETE FROM branches WHERE id=?").run(previousBranchId);
    setRuntimeValue(db, "cloud_url", cloudUrl);
    setRuntimeValue(db, "cloud_sync_token", result.branchToken);
    setRuntimeValue(db, "cloud_device_token", result.deviceToken);
    setRuntimeValue(db, "cloud_pairing_complete", "true");
    setRuntimeValue(db, "setup_provisional_identity", "false");
  });
  localBranchId = result.branch.id;
  process.env.BRANCH_ID = localBranchId;
};

app.get("/api/setup/status", async (_request, reply) => {
  reply.header("Cache-Control", "no-store");
  return {
    requiresOwnerSetup: !ownerExists(),
    requiresPairing: !pairedWithCloud(),
    adminUsername: "admin",
    cloudUrl: enrollmentBaseUrl(),
  };
});

app.post(
  "/api/setup/owner",
  { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
  async (request, reply) => {
    if (ownerExists())
      return reply.status(409).send({ error: "Owner setup is already complete" });
    const body = request.body as {
      password?: string;
      confirmPassword?: string;
      baristaPassword?: string;
      pairingCode?: string;
    };
    if (!body.password || body.password.length < 12 || body.password.length > 128)
      return reply
        .status(400)
        .send({ error: "Use an owner password between 12 and 128 characters" });
    if (body.password !== body.confirmPassword)
      return reply.status(400).send({ error: "Passwords do not match" });
    if (!body.baristaPassword || body.baristaPassword.length < 10 || body.baristaPassword.length > 128)
      return reply
        .status(400)
        .send({ error: "Use a Barista password between 10 and 128 characters" });
    const baristaPassword = body.baristaPassword;

    if (!pairedWithCloud() && body.pairingCode?.trim()) {
      await pairLocalInstallation(body.pairingCode);
    }

    const password = body.password;
    const timestamp = new Date().toISOString();
    try {
      inTransaction(db, () => {
        if (ownerExists()) throw new Error("Owner setup is already complete");
        db.prepare(
          `INSERT INTO users
          (id, branch_id, role_id, name, name_ar, username, password_hash, is_super_admin, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(
          "user-owner",
          localBranchId,
          "role-owner",
          "admin",
          "المدير",
          "admin",
          bcrypt.hashSync(password, 12),
          timestamp,
          timestamp,
        );
        db.prepare(
          `INSERT INTO users
          (id, branch_id, role_id, name, name_ar, username, password_hash, is_super_admin, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        ).run(
          "user-barista",
          localBranchId,
          "role-barista",
          "Barista",
          "باريستا",
          "Barista",
          bcrypt.hashSync(baristaPassword, 12),
          timestamp,
          timestamp,
        );
        insertAudit(db, {
          branchId: localBranchId,
          userId: "user-owner",
          action: "setup.owner_created",
          entityType: "user",
          entityId: "user-owner",
        });
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("already complete"))
        return reply.status(409).send({ error: error.message });
      throw error;
    }
    return reply.status(201).send({
      success: true,
      username: "admin",
    });
  },
);

app.post(
  "/api/setup/pair",
  { preHandler: requirePermission("settings.manage") },
  async (request, reply) => {
    if (cloudServer)
      return reply.status(400).send({ error: "Cloud servers cannot be paired" });
    const pairingCode = String(
      (request.body as { pairingCode?: string }).pairingCode ?? "",
    ).trim();
    if (!pairingCode)
      return reply.status(400).send({ error: "Enter a cloud pairing code" });
    await pairLocalInstallation(pairingCode);
    return {
      paired: true,
      branchId: localBranchId,
    };
  },
);

app.get(
  "/api/auth/login-options",
  { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
  async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (cloudServer) return { mode: "cloud", users: [] };
    const users = db
      .prepare(
        `SELECT id, name, name_ar, username
         FROM users
         WHERE branch_id = ? AND active = 1
         ORDER BY is_super_admin DESC, name COLLATE NOCASE`,
      )
      .all(localBranchId) as Array<{
        id: string;
        name: string;
        name_ar: string;
        username: string;
      }>;
    return {
      mode: "branch",
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        nameAr: user.name_ar,
        username: user.username,
      })),
    };
  },
);

app.post(
  "/api/auth/login",
  {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  },
  async (request, reply) => {
    const body = request.body as {
      username?: string;
      userId?: string;
      password?: string;
    };
    const localUserLogin = !cloudServer && Boolean(body.userId);
    if ((!body.username && !localUserLogin) || !body.password)
      return reply
        .status(400)
        .send({ error: "User and password are required" });
    const user = (localUserLogin
      ? db
          .prepare(
            `SELECT id, branch_id, role_id, name, name_ar, username, password_hash, is_super_admin, active
             FROM users WHERE id = ? AND branch_id = ?`,
          )
          .get(body.userId ?? "", localBranchId)
      : db
          .prepare(
            `SELECT id, branch_id, role_id, name, name_ar, username, password_hash, is_super_admin, active
             FROM users WHERE username = ? COLLATE NOCASE`,
          )
          .get(body.username ?? "")) as Record<string, unknown> | undefined;
    if (
      !user ||
      !user.active ||
      !bcrypt.compareSync(body.password, String(user.password_hash))
    ) {
      return reply.status(401).send({ error: "Invalid user or password" });
    }
    const userPermissionList = userPermissions(
      String(user.id),
      user.role_id ? String(user.role_id) : null,
    );
    const session = {
      id: String(user.id),
      name: String(user.name),
      nameAr: String(user.name_ar),
      username: String(user.username),
      branchId: String(user.branch_id),
      isSuperAdmin: Boolean(user.is_super_admin),
      permissions: userPermissionList,
      ...sessionLocation(String(user.branch_id)),
    };
    const token = await reply.jwtSign(
      {
        sub: session.id,
        branchId: session.branchId,
        name: session.name,
        nameAr: session.nameAr,
        isSuperAdmin: session.isSuperAdmin,
        permissions: session.permissions,
      },
      { expiresIn: "8h" },
    );
    insertAudit(db, {
      branchId: session.branchId,
      userId: session.id,
      action: "auth.login",
      entityType: "user",
      entityId: session.id,
    });
    return { token, user: session };
  },
);

app.get("/api/session", { preHandler: authenticate }, async (request) => {
  const user = db
    .prepare(
      `SELECT id, branch_id, role_id, name, name_ar, username, is_super_admin
    FROM users WHERE id = ? AND active = 1`,
    )
    .get(request.user.sub) as Record<string, unknown> | undefined;
  if (!user)
    throw Object.assign(new Error("Session user not found"), {
      statusCode: 401,
    });
  return {
    id: user.id,
    branchId: user.branch_id,
    name: user.name,
    nameAr: user.name_ar,
    username: user.username,
    isSuperAdmin: Boolean(user.is_super_admin),
    permissions: userPermissions(
      String(user.id),
      user.role_id ? String(user.role_id) : null,
    ),
    ...sessionLocation(String(user.branch_id)),
  };
});

app.get(
  "/api/cloud/overview",
  { preHandler: requirePermission("reports.financial") },
  async () => {
    if (process.env.CLOUD_RECEIVER_ENABLED !== "true")
      return {
        enabled: false,
        branches: [],
        recent: [],
        summary: { revenue: 0, transactions: 0, pendingBranches: 0 },
      };
    const rows = db
      .prepare(
        "SELECT * FROM cloud_sync_events ORDER BY received_at DESC LIMIT 2000",
      )
      .all() as unknown as Array<{
      event_id: string;
      branch_id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: string;
      occurred_at: string;
      received_at: string;
    }>;
    const decoded = rows.map((row) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {}
      return { ...row, payload };
    });
    const sales = decoded.filter((row) => row.event_type === "order.completed");
    const voided = new Set(
      decoded
        .filter((row) => row.event_type === "order.voided")
        .map((row) => row.aggregate_id),
    );
    const refunded = new Set(
      decoded
        .filter((row) => row.event_type === "order.refunded")
        .map((row) => row.aggregate_id),
    );
    const completed = sales.filter(
      (row) => !voided.has(row.aggregate_id) && !refunded.has(row.aggregate_id),
    );
    const domainEvents = decoded.filter(
      (row) => row.event_type !== "audit.recorded",
    );
    const auditEvents = decoded.filter(
      (row) => row.event_type === "audit.recorded",
    );
    const latestShiftState = new Map<string, string>();
    const latestCustomerBalances = new Map<string, number>();
    for (const row of decoded) {
      if (
        row.aggregate_type === "shift" &&
        !latestShiftState.has(row.aggregate_id)
      )
        latestShiftState.set(row.aggregate_id, row.event_type);
      if (
        row.event_type === "order.completed" &&
        row.payload.customerId &&
        !latestCustomerBalances.has(String(row.payload.customerId))
      )
        latestCustomerBalances.set(
          String(row.payload.customerId),
          Number(row.payload.customerBalance ?? 0),
        );
      if (
        row.event_type === "audit.recorded" &&
        row.payload.action === "customer.credit_payment"
      ) {
        const customerId = String(row.payload.entityId ?? "");
        const next = row.payload.newValue as
          Record<string, unknown> | undefined;
        if (customerId && !latestCustomerBalances.has(customerId))
          latestCustomerBalances.set(customerId, Number(next?.balance ?? 0));
      }
      if (
        row.event_type === "customer.credit_payment" &&
        row.payload.customerId &&
        !latestCustomerBalances.has(String(row.payload.customerId))
      )
        latestCustomerBalances.set(
          String(row.payload.customerId),
          Number(row.payload.balance ?? 0),
        );
    }
    const branchMap = new Map<
      string,
      {
        branchId: string;
        revenue: number;
        transactions: number;
        voids: number;
        refunds: number;
        auditEvents: number;
        inventoryEvents: number;
        staffEvents: number;
        lastSeen: string;
      }
    >();
    for (const row of decoded) {
      const entry = branchMap.get(row.branch_id) ?? {
        branchId: row.branch_id,
        revenue: 0,
        transactions: 0,
        voids: 0,
        refunds: 0,
        auditEvents: 0,
        inventoryEvents: 0,
        staffEvents: 0,
        lastSeen: row.received_at,
      };
      if (row.received_at > entry.lastSeen) entry.lastSeen = row.received_at;
      if (
        row.event_type === "order.completed" &&
        !voided.has(row.aggregate_id) &&
        !refunded.has(row.aggregate_id)
      ) {
        entry.revenue += Number(row.payload.total ?? 0);
        entry.transactions += 1;
      }
      if (row.event_type === "order.voided") entry.voids += 1;
      if (row.event_type === "order.refunded") entry.refunds += 1;
      if (row.event_type === "audit.recorded") entry.auditEvents += 1;
      if (
        ["inventory_item", "inventory_transfer", "product"].includes(
          row.aggregate_type,
        ) &&
        row.event_type !== "product.created" &&
        row.event_type !== "product.updated"
      )
        entry.inventoryEvents += 1;
      if (["user", "staff_ledger"].includes(row.aggregate_type))
        entry.staffEvents += 1;
      branchMap.set(row.branch_id, entry);
    }
    return {
      enabled: true,
      summary: {
        revenue: completed.reduce(
          (sum, row) => sum + Number(row.payload.total ?? 0),
          0,
        ),
        transactions: completed.length,
        events: rows.length,
        voids: voided.size,
        refunds: refunded.size,
        auditEvents: auditEvents.length,
        inventoryEvents: domainEvents.filter(
          (row) =>
            (["inventory_item", "inventory_transfer", "product"].includes(
              row.aggregate_type,
            ) &&
              row.event_type.includes("inventory")) ||
            row.event_type.includes("stock"),
        ).length,
        customerEvents: domainEvents.filter(
          (row) => row.aggregate_type === "customer",
        ).length,
        staffEvents: domainEvents.filter((row) =>
          ["user", "staff_ledger"].includes(row.aggregate_type),
        ).length,
        treasuryEvents: domainEvents.filter((row) =>
          ["treasury_movement", "expense"].includes(row.aggregate_type),
        ).length,
        activeShifts: [...latestShiftState.values()].filter(
          (event) => event === "shift.opened",
        ).length,
        outstandingCredit: [...latestCustomerBalances.values()].reduce(
          (sum, value) => sum + value,
          0,
        ),
      },
      branches: [...branchMap.values()],
      recent: decoded.slice(0, 100),
      recentTransactions: sales.slice(0, 50).map((row) => ({
        branchId: row.branch_id,
        orderId: row.aggregate_id,
        status: voided.has(row.aggregate_id)
          ? "voided"
          : refunded.has(row.aggregate_id)
            ? "refunded"
            : "completed",
        orderNumber: row.payload.orderNumber,
        total: row.payload.total,
        paymentMethod: row.payload.paymentMethod,
        occurredAt: row.occurred_at,
      })),
    };
  },
);

app.get(
  "/api/cloud/reports",
  { preHandler: requirePermission("reports.financial") },
  async (request, reply) => {
    if (process.env.CLOUD_RECEIVER_ENABLED !== "true")
      return reply.status(404).send({ error: "Cloud receiver is not enabled" });
    const query = request.query as {
      from?: string;
      to?: string;
      branches?: string;
      employeeId?: string;
      paymentMethod?: string;
      productId?: string;
      categoryId?: string;
      customerId?: string;
    };
    const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to ?? "")
      ? query.to!
      : currentBusinessDate();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from ?? "")
      ? query.from!
      : `${to.slice(0, 8)}01`;
    const requestedBranches = (query.branches ?? "").split(",").filter(Boolean);
    const rawRows = db
      .prepare(
        `SELECT * FROM cloud_sync_events WHERE substr(occurred_at,1,10) BETWEEN ? AND ? ORDER BY occurred_at`,
      )
      .all(from, to) as unknown as Array<{
      event_id: string;
      branch_id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      occurred_at: string;
      payload: string;
    }>;
    const decoded = rawRows.map((row) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {}
      return { ...row, payload };
    });
    const allowedBranches = request.user.isSuperAdmin
      ? requestedBranches
      : [request.user.branchId];
    const rows = allowedBranches.length
      ? decoded.filter((row) => allowedBranches.includes(row.branch_id))
      : decoded;
    const voided = new Set(
      rows
        .filter((row) => row.event_type === "order.voided")
        .map((row) => row.aggregate_id),
    );
    const refunded = new Set(
      rows
        .filter((row) => row.event_type === "order.refunded")
        .map((row) => row.aggregate_id),
    );
    type CloudItem = {
      productId?: string;
      categoryId?: string;
      categoryName?: string;
      categoryNameAr?: string;
      name?: string;
      nameAr?: string;
      quantity?: number;
      total?: number;
      unitCost?: number;
    };
    const allSales = rows.filter((row) => row.event_type === "order.completed");
    const matchingSales = allSales.filter((row) => {
      const payload = row.payload;
      const items = Array.isArray(payload.items)
        ? (payload.items as CloudItem[])
        : [];
      return (
        !voided.has(row.aggregate_id) &&
        !refunded.has(row.aggregate_id) &&
        (!query.employeeId || payload.userId === query.employeeId) &&
        (!query.paymentMethod ||
          payload.paymentMethod === query.paymentMethod) &&
        (!query.customerId || payload.customerId === query.customerId) &&
        (!query.productId ||
          items.some((item) => item.productId === query.productId)) &&
        (!query.categoryId ||
          items.some((item) => item.categoryId === query.categoryId))
      );
    });
    const group = <T extends Record<string, unknown>>(
      map: Map<string, T>,
      key: string,
      initial: T,
    ) => {
      const current = map.get(key) ?? initial;
      map.set(key, current);
      return current;
    };
    const dailyMap = new Map<
      string,
      { date: string; revenue: number; orders: number }
    >();
    const paymentMap = new Map<
      string,
      { payment_method: string; revenue: number; orders: number }
    >();
    const productMap = new Map<
      string,
      {
        id: string;
        name: string;
        name_ar: string;
        quantity: number;
        revenue: number;
        gross_profit: number;
      }
    >();
    const categoryMap = new Map<
      string,
      {
        id: string;
        name: string;
        name_ar: string;
        quantity: number;
        revenue: number;
      }
    >();
    const staffMap = new Map<
      string,
      { id: string; name: string; orders: number; revenue: number }
    >();
    const customerMap = new Map<string, { id: string; name: string }>();
    for (const row of matchingSales) {
      const payload = row.payload;
      const total = Number(payload.total ?? 0);
      const date = String(payload.businessDate ?? row.occurred_at.slice(0, 10));
      const daily = group(dailyMap, date, { date, revenue: 0, orders: 0 });
      daily.revenue += total;
      daily.orders += 1;
      const method = String(payload.paymentMethod ?? "unknown");
      const payment = group(paymentMap, method, {
        payment_method: method,
        revenue: 0,
        orders: 0,
      });
      payment.revenue += total;
      payment.orders += 1;
      const userId = String(payload.userId ?? "unknown");
      const staff = group(staffMap, userId, {
        id: userId,
        name: String(payload.userName ?? userId),
        revenue: 0,
        orders: 0,
      });
      staff.revenue += total;
      staff.orders += 1;
      if (payload.customerId)
        customerMap.set(String(payload.customerId), {
          id: String(payload.customerId),
          name: String(payload.customerName ?? payload.customerId),
        });
      const items = Array.isArray(payload.items)
        ? (payload.items as CloudItem[])
        : [];
      for (const item of items) {
        const productId = String(item.productId ?? item.name ?? "unknown");
        const quantity = Number(item.quantity ?? 0);
        const revenue = Number(item.total ?? 0);
        const product = group(productMap, productId, {
          id: productId,
          name: String(item.name ?? productId),
          name_ar: String(item.nameAr ?? item.name ?? productId),
          quantity: 0,
          revenue: 0,
          gross_profit: 0,
        });
        product.quantity += quantity;
        product.revenue += revenue;
        product.gross_profit += revenue - Number(item.unitCost ?? 0) * quantity;
        const categoryId = String(item.categoryId ?? "uncategorized");
        const category = group(categoryMap, categoryId, {
          id: categoryId,
          name: String(item.categoryName ?? categoryId),
          name_ar: String(
            item.categoryNameAr ?? item.categoryName ?? categoryId,
          ),
          quantity: 0,
          revenue: 0,
        });
        category.quantity += quantity;
        category.revenue += revenue;
      }
    }
    const branchNames = new Map<string, { name: string; nameAr: string }>();
    decoded
      .filter((row) => row.event_type.startsWith("branch."))
      .forEach((row) =>
        branchNames.set(row.aggregate_id, {
          name: String(row.payload.name ?? row.aggregate_id),
          nameAr: String(
            row.payload.nameAr ?? row.payload.name ?? row.aggregate_id,
          ),
        }),
      );
    const allBranchIds = [...new Set(decoded.map((row) => row.branch_id))];
    const branchIds = [...new Set(rows.map((row) => row.branch_id))];
    const branchComparison = branchIds.map((id) => {
      const sales = matchingSales.filter((row) => row.branch_id === id);
      return {
        id,
        name: branchNames.get(id)?.name ?? id,
        name_ar: branchNames.get(id)?.nameAr ?? id,
        orders: sales.length,
        revenue: sales.reduce(
          (sum, row) => sum + Number(row.payload.total ?? 0),
          0,
        ),
      };
    });
    const refundRows = rows.filter(
      (row) => row.event_type === "order.refunded",
    );
    const expenses = rows
      .filter((row) => row.event_type === "expense.created")
      .reduce((sum, row) => sum + Number(row.payload.amount ?? 0), 0);
    const inventoryMap = new Map<
      string,
      { type: string; movements: number; quantity: number }
    >();
    rows
      .filter(
        (row) =>
          row.aggregate_type === "inventory_item" ||
          row.aggregate_type === "inventory_transfer",
      )
      .forEach((row) => {
        const movement = group(inventoryMap, row.event_type, {
          type: row.event_type,
          movements: 0,
          quantity: 0,
        });
        movement.movements += 1;
        movement.quantity += Number(row.payload.quantity ?? 0);
      });
    const treasuryMap = new Map<
      string,
      { type: string; amount: number; movements: number }
    >();
    rows
      .filter((row) =>
        ["treasury_movement", "expense"].includes(row.aggregate_type),
      )
      .forEach((row) => {
        const type = String(row.payload.type ?? row.event_type);
        const movement = group(treasuryMap, type, {
          type,
          amount: 0,
          movements: 0,
        });
        movement.amount += Number(row.payload.amount ?? 0);
        movement.movements += 1;
      });
    const customerPayments = rows.filter(
      (row) => row.event_type === "customer.credit_payment",
    );
    const balanceMap = new Map<string, number>();
    [...rows].reverse().forEach((row) => {
      if (
        row.event_type === "order.completed" &&
        row.payload.customerId &&
        !balanceMap.has(String(row.payload.customerId))
      )
        balanceMap.set(
          String(row.payload.customerId),
          Number(row.payload.customerBalance ?? 0),
        );
      if (
        row.event_type === "customer.credit_payment" &&
        !balanceMap.has(String(row.payload.customerId ?? row.aggregate_id))
      )
        balanceMap.set(
          String(row.payload.customerId ?? row.aggregate_id),
          Number(row.payload.balance ?? row.payload.newBalance ?? 0),
        );
    });
    const revenue = matchingSales.reduce(
      (sum, row) => sum + Number(row.payload.total ?? 0),
      0,
    );
    const filters = {
      branches: allBranchIds.map((id) => ({
        id,
        name: branchNames.get(id)?.name ?? id,
        name_ar: branchNames.get(id)?.nameAr ?? id,
      })),
      employees: [...staffMap.values()].map(({ id, name }) => ({
        id,
        name,
        name_ar: name,
      })),
      products: [...productMap.values()].map(({ id, name, name_ar }) => ({
        id,
        name,
        name_ar,
      })),
      categories: [...categoryMap.values()].map(({ id, name, name_ar }) => ({
        id,
        name,
        name_ar,
      })),
      customers: [...customerMap.values()],
    };
    return {
      source: "cloud",
      from,
      to,
      summary: {
        revenue,
        orders: matchingSales.length,
        discounts: matchingSales.reduce(
          (sum, row) => sum + Number(row.payload.discountAmount ?? 0),
          0,
        ),
        average_order: matchingSales.length
          ? Math.round(revenue / matchingSales.length)
          : 0,
        voids: voided.size,
        refunds: refundRows.length,
        refund_amount: refundRows.reduce(
          (sum, row) => sum + Number(row.payload.amount ?? 0),
          0,
        ),
      },
      daily: [...dailyMap.values()].sort((a, b) =>
        a.date.localeCompare(b.date),
      ),
      payments: [...paymentMap.values()],
      products: [...productMap.values()].sort((a, b) => b.revenue - a.revenue),
      staff: [...staffMap.values()],
      expenses,
      ingredients: [],
      categorySales: [...categoryMap.values()],
      treasury: [...treasuryMap.values()],
      inventoryMovements: [...inventoryMap.values()],
      customerPayments: {
        amount: customerPayments.reduce(
          (sum, row) => sum + Number(row.payload.amount ?? 0),
          0,
        ),
        payments: customerPayments.length,
      },
      customerOutstanding: {
        amount: [...balanceMap.values()].reduce((sum, value) => sum + value, 0),
        customers: [...balanceMap.values()].filter((value) => value > 0).length,
      },
      shiftDifferences: rows
        .filter((row) => row.event_type === "shift.closed")
        .map((row) => ({
          id: row.aggregate_id,
          name: String(row.payload.userName ?? row.payload.userId ?? "Staff"),
          closed_at: row.occurred_at,
          expected_cash: Number(row.payload.expected ?? 0),
          closing_cash: Number(row.payload.closingCash ?? 0),
          difference: Number(row.payload.difference ?? 0),
        })),
      branchComparison,
      employeeAudit: [],
      filters,
    };
  },
);

app.post("/api/auth/logout", { preHandler: authenticate }, async (request) => {
  insertAudit(db, {
    branchId: request.user.branchId,
    userId: request.user.sub,
    action: "auth.logout",
    entityType: "user",
    entityId: request.user.sub,
  });
  return { success: true };
});

app.get(
  "/api/catalog",
  { preHandler: requirePermission("pos.access") },
  async (request) => {
    const categories = (
      db
        .prepare(
          "SELECT id, name, name_ar, icon, color, sort_order, active FROM categories WHERE active = 1 ORDER BY sort_order, name",
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => rowBoolean(row, ["active"]));
    const products = (
      db
        .prepare(
          `SELECT p.id, p.category_id, p.sku, p.barcode, p.name, p.name_ar, p.description, p.price, p.cost, p.stock, p.low_stock_at, p.image, p.color, p.active, p.track_stock
    FROM products p WHERE p.active = 1 AND NOT EXISTS (SELECT 1 FROM product_branch_availability pba WHERE pba.product_id = p.id AND pba.branch_id = ? AND pba.available = 0) ORDER BY p.name`,
        )
        .all(request.user.branchId) as Array<Record<string, unknown>>
    ).map((row) => rowBoolean(row, ["active", "track_stock"]));
    const variants = (
      db
        .prepare(
          `SELECT id, product_id, name, name_ar, price, cost, sku, estimated_weight, estimated_weight_unit, stock, low_stock_at, track_stock, active, sort_order
    FROM product_variants WHERE active = 1 ORDER BY product_id, sort_order`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => rowBoolean(row, ["active", "track_stock"]));
    return { categories, products, variants };
  },
);

app.get(
  "/api/admin/catalog",
  { preHandler: requirePermission("products.manage") },
  async () => ({
    categories: (
      db
        .prepare("SELECT * FROM categories ORDER BY sort_order, name")
        .all() as Array<Record<string, unknown>>
    ).map((row) => rowBoolean(row, ["active"])),
    products: (
      db
        .prepare(
          `SELECT p.*, c.name AS category_name, c.name_ar AS category_name_ar FROM products p JOIN categories c ON c.id = p.category_id
    ORDER BY p.updated_at DESC, p.name`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => rowBoolean(row, ["active", "track_stock"])),
    variants: (
      db
        .prepare(
          "SELECT * FROM product_variants ORDER BY product_id, sort_order",
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => rowBoolean(row, ["active"])),
    ingredients: (
      db.prepare("SELECT * FROM inventory_items ORDER BY name").all() as Array<
        Record<string, unknown>
      >
    ).map((row) => rowBoolean(row, ["active"])),
    recipes: db.prepare("SELECT * FROM recipe_components").all(),
    availability: db.prepare("SELECT * FROM product_branch_availability").all(),
    branches: db
      .prepare(
        "SELECT id, name, name_ar FROM branches WHERE active = 1 ORDER BY name",
      )
      .all(),
  }),
);

app.post(
  "/api/categories",
  { preHandler: requirePermission("categories.manage") },
  async (request, reply) => {
    const body = request.body as {
      name?: string;
      nameAr?: string;
      icon?: string;
      color?: string;
    };
    if (!body.name?.trim() || !body.nameAr?.trim())
      return reply
        .status(400)
        .send({ error: "English and Arabic names are required" });
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const sortOrder = (
      db
        .prepare(
          "SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM categories",
        )
        .get() as { value: number }
    ).value;
    db.prepare(
      `INSERT INTO categories (id, name, name_ar, icon, color, sort_order, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      body.name.trim(),
      body.nameAr.trim(),
      body.icon ?? "Coffee",
      body.color ?? "#C9976A",
      sortOrder,
      timestamp,
    );
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "category.created",
      entityType: "category",
      entityId: id,
      newValue: body,
    });
    enqueueSync(db, request.user.branchId, "category", id, "category.created", {
      id,
      ...body,
      timestamp,
    });
    return reply.status(201).send({ id });
  },
);

app.patch(
  "/api/categories/:id",
  { preHandler: requirePermission("categories.manage") },
  async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as Record<string, unknown>;
    const existing = db
      .prepare("SELECT * FROM categories WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!existing)
      return reply.status(404).send({ error: "Category not found" });
    const allowed: Record<string, string> = {
      name: "name",
      nameAr: "name_ar",
      icon: "icon",
      color: "color",
      active: "active",
      sortOrder: "sort_order",
    };
    const updates = Object.entries(body).filter(([key]) => key in allowed);
    if (!updates.length)
      return reply.status(400).send({ error: "No editable fields supplied" });
    if (
      (body.name !== undefined && !String(body.name).trim()) ||
      (body.nameAr !== undefined && !String(body.nameAr).trim())
    ) {
      return reply
        .status(400)
        .send({ error: "Category names cannot be blank" });
    }
    const values = updates.map(([, value]) =>
      typeof value === "boolean"
        ? Number(value)
        : typeof value === "string"
          ? value.trim()
          : (value as number),
    );
    const timestamp = new Date().toISOString();
    db.prepare(
      `UPDATE categories SET ${updates.map(([key]) => `${allowed[key]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
    ).run(...values, timestamp, id);
    const updated = db.prepare("SELECT * FROM categories WHERE id = ?").get(id);
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "category.updated",
      entityType: "category",
      entityId: id,
      originalValue: existing,
      newValue: updated,
    });
    enqueueSync(
      db,
      request.user.branchId,
      "category",
      id,
      "category.updated",
      updated,
    );
    return { category: updated };
  },
);

type RecipeComponentInput = {
  ingredientId?: string;
  quantity?: number;
  unit?: string;
};

const insertRecipeComponents = (
  productId: string,
  variantId: string | null,
  components: RecipeComponentInput[],
  branchId: string,
) => {
  const insert = db.prepare(`INSERT INTO recipe_components
    (id,product_id,variant_id,inventory_item_id,quantity,unit) VALUES (?, ?, ?, ?, ?, ?)`);
  const seen = new Set<string>();
  for (const component of components) {
    const ingredientId = String(component.ingredientId ?? "");
    const quantity = Number(component.quantity ?? 0);
    if (!ingredientId && quantity === 0) continue;
    if (!ingredientId || !Number.isFinite(quantity) || quantity <= 0)
      throw Object.assign(new Error("Each recipe row requires an ingredient and positive usage"), { statusCode: 400 });
    if (seen.has(ingredientId))
      throw Object.assign(new Error("The same ingredient cannot appear twice in one recipe"), { statusCode: 400 });
    const ingredient = db.prepare(
      "SELECT id,unit FROM inventory_items WHERE id=? AND branch_id=? AND active=1",
    ).get(ingredientId, branchId) as { id: string; unit: string } | undefined;
    if (!ingredient)
      throw Object.assign(new Error("Selected ingredient was not found in this branch"), { statusCode: 400 });
    if (component.unit && ingredient.unit !== component.unit)
      throw Object.assign(new Error("Ingredient usage unit must match its inventory unit"), { statusCode: 400 });
    seen.add(ingredientId);
    insert.run(randomUUID(), productId, variantId, ingredient.id, quantity, ingredient.unit);
  }
};

app.post(
  "/api/products",
  { preHandler: requirePermission("products.manage") },
  async (request, reply) => {
    const body = request.body as {
      categoryId?: string;
      sku?: string;
      barcode?: string;
      name?: string;
      nameAr?: string;
      description?: string;
      notes?: string;
      price?: number;
      cost?: number;
      stock?: number;
      lowStockAt?: number;
      image?: string;
      color?: string;
      trackStock?: boolean;
      branchIds?: string[];
      ingredientId?: string;
      estimatedWeight?: number;
      estimatedWeightUnit?: string;
      recipeComponents?: RecipeComponentInput[];
      variants?: Array<{
        name: string;
        nameAr: string;
        price: number;
        cost?: number;
        sku?: string;
        ingredientId?: string;
        estimatedWeight?: number;
        estimatedWeightUnit?: string;
        recipeComponents?: RecipeComponentInput[];
        stock?: number;
        lowStockAt?: number;
        trackStock?: boolean;
      }>;
    };
    if (
      !body.categoryId ||
      !body.name?.trim() ||
      !body.nameAr?.trim() ||
      !Number.isInteger(body.price) ||
      Number(body.price) < 0
    ) {
      return reply.status(400).send({
        error: "Category, bilingual names, and a valid price are required",
      });
    }
    const category = db
      .prepare("SELECT id FROM categories WHERE id = ?")
      .get(body.categoryId);
    if (!category)
      return reply.status(400).send({ error: "Category not found" });
    const categoryId = body.categoryId;
    const productName = body.name.trim();
    const productNameAr = body.nameAr.trim();
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    try {
      inTransaction(db, () => {
        db.prepare(
          `INSERT INTO products
      (id, category_id, sku, barcode, name, name_ar, description, notes, price, cost, stock, low_stock_at, image, color, track_stock, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          categoryId,
          body.sku?.trim().toUpperCase() ||
            `PRD-${id.slice(0, 8).toUpperCase()}`,
          body.barcode?.trim() || null,
          productName,
          productNameAr,
          body.description ?? "",
          body.notes ?? "",
          Number(body.price),
          Number(body.cost ?? 0),
          Number(body.stock ?? 0),
          Number(body.lowStockAt ?? 5),
          body.image ?? "☕",
          body.color ?? "#E9D7C8",
          body.trackStock === false ? 0 : 1,
          timestamp,
        );
        const variantInsert = db.prepare(`INSERT INTO product_variants
        (id, product_id, name, name_ar, price, cost, sku, estimated_weight, estimated_weight_unit, stock, low_stock_at, track_stock, sort_order, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const baseComponents = Array.isArray(body.recipeComponents) ? body.recipeComponents : (body.ingredientId ? [{
          ingredientId: body.ingredientId,
          quantity: Number(body.estimatedWeight ?? 0),
          unit: String(body.estimatedWeightUnit ?? ""),
        }] : []);
        insertRecipeComponents(id, null, baseComponents, request.user.branchId);
        (body.variants ?? []).forEach((variant, index) => {
          if (
            !variant.name?.trim() ||
            !variant.nameAr?.trim() ||
            !Number.isInteger(variant.price) ||
            variant.price < 0
          ) {
            throw new Error("INVALID_VARIANT");
          }
          const variantId = randomUUID();
          variantInsert.run(
            variantId,
            id,
            variant.name.trim(),
            variant.nameAr.trim(),
            variant.price,
            variant.cost ?? 0,
            variant.sku?.trim() || null,
            variant.estimatedWeight ?? null,
            variant.estimatedWeightUnit ?? null,
            Number(variant.stock ?? 0),
            Number(variant.lowStockAt ?? 0),
            variant.trackStock ? 1 : 0,
            index,
            timestamp,
          );
          const variantComponents = Array.isArray(variant.recipeComponents) ? variant.recipeComponents : (variant.ingredientId ? [{
            ingredientId: variant.ingredientId,
            quantity: Number(variant.estimatedWeight ?? 0),
            unit: String(variant.estimatedWeightUnit ?? ""),
          }] : []);
          insertRecipeComponents(id, variantId, variantComponents, request.user.branchId);
        });
        if (body.branchIds?.length) {
          const branches = db
            .prepare("SELECT id FROM branches WHERE active = 1")
            .all() as unknown as Array<{ id: string }>;
          const selected = new Set(body.branchIds);
          const availabilityInsert = db.prepare(
            "INSERT INTO product_branch_availability (product_id, branch_id, available) VALUES (?, ?, ?)",
          );
          branches.forEach((branch) =>
            availabilityInsert.run(
              id,
              branch.id,
              Number(selected.has(branch.id)),
            ),
          );
        }
      });
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_VARIANT")
        return reply.status(400).send({
          error: "Each variant requires bilingual names and a valid price",
        });
      if (error instanceof Error && error.message === "INVALID_INGREDIENT")
        return reply
          .status(400)
          .send({ error: "Selected ingredient was not found" });
      if (
        error instanceof Error &&
        error.message === "INGREDIENT_UNIT_MISMATCH"
      )
        return reply.status(400).send({
          error: "Variant usage unit must match the selected ingredient",
        });
      if (error instanceof Error && error.message.includes("UNIQUE"))
        return reply.status(409).send({ error: "SKU already exists" });
      throw error;
    }
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "product.created",
      entityType: "product",
      entityId: id,
      newValue: body,
    });
    enqueueSync(db, request.user.branchId, "product", id, "product.created", {
      id,
      ...body,
      timestamp,
    });
    return reply.status(201).send({ id });
  },
);

app.patch(
  "/api/products/:id",
  { preHandler: requirePermission("products.manage") },
  async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as Record<string, unknown>;
    const existing = db
      .prepare("SELECT * FROM products WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!existing)
      return reply.status(404).send({ error: "Product not found" });
    const allowed: Record<string, string> = {
      categoryId: "category_id",
      sku: "sku",
      barcode: "barcode",
      name: "name",
      nameAr: "name_ar",
      description: "description",
      notes: "notes",
      price: "price",
      cost: "cost",
      stock: "stock",
      lowStockAt: "low_stock_at",
      image: "image",
      color: "color",
      trackStock: "track_stock",
      active: "active",
    };
    const updates = Object.entries(body).filter(([key]) => key in allowed);
    const branchIds = Array.isArray(body.branchIds)
      ? body.branchIds.map(String)
      : null;
    const changesRecipe = Object.hasOwn(body, "recipeComponents") || Object.hasOwn(body, "ingredientId");
    if (!updates.length && !branchIds && !changesRecipe)
      return reply.status(400).send({ error: "No editable fields supplied" });
    const timestamp = new Date().toISOString();
    const values = updates.map(([key, value]) =>
      typeof value === "boolean"
        ? Number(value)
        : (value as string | number | null),
    );
    inTransaction(db, () => {
      if (updates.length)
        db.prepare(
          `UPDATE products SET ${updates.map(([key]) => `${allowed[key]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
        ).run(...values, timestamp, id);
      if (branchIds) {
        db.prepare(
          "DELETE FROM product_branch_availability WHERE product_id = ?",
        ).run(id);
        const insert = db.prepare(
          "INSERT INTO product_branch_availability (product_id, branch_id, available) VALUES (?, ?, ?)",
        );
        const branches = db
          .prepare("SELECT id FROM branches WHERE active = 1")
          .all() as unknown as Array<{ id: string }>;
        const selected = new Set(branchIds);
        branches.forEach((branch) =>
          insert.run(id, branch.id, Number(selected.has(branch.id))),
        );
      }
      if (changesRecipe) {
        db.prepare(
          "DELETE FROM recipe_components WHERE product_id=? AND variant_id IS NULL",
        ).run(id);
        const components = Array.isArray(body.recipeComponents)
          ? (body.recipeComponents as RecipeComponentInput[])
          : body.ingredientId
            ? [{ ingredientId: String(body.ingredientId), quantity: Number(body.estimatedWeight ?? 0), unit: String(body.estimatedWeightUnit ?? "") }]
            : [];
        insertRecipeComponents(id, null, components, request.user.branchId);
      }
    });
    const updated = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "product.updated",
      entityType: "product",
      entityId: id,
      originalValue: existing,
      newValue: updated,
    });
    enqueueSync(
      db,
      request.user.branchId,
      "product",
      id,
      "product.updated",
      updated,
    );
    return { product: updated };
  },
);

app.post(
  "/api/products/:id/variants",
  { preHandler: requirePermission("products.manage") },
  async (request, reply) => {
    const productId = (request.params as { id: string }).id;
    const body = request.body as {
      name?: string;
      nameAr?: string;
      price?: number;
      cost?: number;
      sku?: string;
      ingredientId?: string;
      estimatedWeight?: number;
      estimatedWeightUnit?: string;
      recipeComponents?: RecipeComponentInput[];
      stock?: number;
      lowStockAt?: number;
      trackStock?: boolean;
    };
    if (!db.prepare("SELECT id FROM products WHERE id=?").get(productId))
      return reply.status(404).send({ error: "Product not found" });
    if (
      !body.name?.trim() ||
      !body.nameAr?.trim() ||
      !Number.isInteger(body.price) ||
      Number(body.price) < 0
    )
      return reply
        .status(400)
        .send({ error: "Bilingual names and a valid price are required" });
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    inTransaction(db, () => {
      db.prepare(
        `INSERT INTO product_variants (id,product_id,name,name_ar,price,cost,sku,estimated_weight,estimated_weight_unit,stock,low_stock_at,track_stock,sort_order,updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order),-1)+1 FROM product_variants WHERE product_id=?), ?)`,
      ).run(
        id,
        productId,
        body.name!.trim(),
        body.nameAr!.trim(),
        Number(body.price),
        Number(body.cost ?? 0),
        body.sku?.trim() || null,
        body.estimatedWeight ?? null,
        body.estimatedWeightUnit ?? null,
        Number(body.stock ?? 0),
        Number(body.lowStockAt ?? 0),
        Number(body.trackStock),
        productId,
        timestamp,
      );
      const components = Array.isArray(body.recipeComponents) ? body.recipeComponents : (body.ingredientId ? [{
        ingredientId: body.ingredientId,
        quantity: Number(body.estimatedWeight ?? 0),
        unit: String(body.estimatedWeightUnit ?? ""),
      }] : []);
      insertRecipeComponents(productId, id, components, request.user.branchId);
    });
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "variant.created",
      entityType: "product_variant",
      entityId: id,
      newValue: body,
    });
    enqueueSync(
      db,
      request.user.branchId,
      "product_variant",
      id,
      "variant.created",
      { id, productId, ...body, timestamp },
    );
    return reply.status(201).send({ id });
  },
);

app.patch(
  "/api/variants/:id",
  { preHandler: requirePermission("products.manage") },
  async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as Record<string, unknown>;
    const existing = db
      .prepare("SELECT * FROM product_variants WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!existing)
      return reply.status(404).send({ error: "Variant not found" });
    const allowed: Record<string, string> = {
      name: "name",
      nameAr: "name_ar",
      price: "price",
      cost: "cost",
      sku: "sku",
      estimatedWeight: "estimated_weight",
      estimatedWeightUnit: "estimated_weight_unit",
      stock: "stock",
      lowStockAt: "low_stock_at",
      trackStock: "track_stock",
      active: "active",
    };
    const updates = Object.entries(body).filter(([key]) => key in allowed);
    const changesRecipe =
      Object.hasOwn(body, "recipeComponents") ||
      Object.hasOwn(body, "ingredientId");
    if (!updates.length && !changesRecipe)
      return reply.status(400).send({ error: "No editable fields supplied" });
    const values = updates.map(([, value]) =>
      typeof value === "boolean"
        ? Number(value)
        : (value as string | number | null),
    );
    const timestamp = new Date().toISOString();
    inTransaction(db, () => {
      if (updates.length)
        db.prepare(
          `UPDATE product_variants SET ${updates.map(([key]) => `${allowed[key]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
        ).run(...values, timestamp, id);
      if (changesRecipe) {
        db.prepare("DELETE FROM recipe_components WHERE variant_id = ?").run(
          id,
        );
        const components = Array.isArray(body.recipeComponents)
          ? (body.recipeComponents as RecipeComponentInput[])
          : body.ingredientId
            ? [
                {
                  ingredientId: String(body.ingredientId),
                  quantity: Number(body.estimatedWeight ?? 0),
                  unit: String(body.estimatedWeightUnit ?? ""),
                },
              ]
            : [];
        insertRecipeComponents(
          String(existing.product_id),
          id,
          components,
          request.user.branchId,
        );
      }
    });
    const updated = db
      .prepare("SELECT * FROM product_variants WHERE id = ?")
      .get(id);
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "variant.updated",
      entityType: "product_variant",
      entityId: id,
      originalValue: existing,
      newValue: updated,
    });
    enqueueSync(
      db,
      request.user.branchId,
      "product_variant",
      id,
      "variant.updated",
      updated,
    );
    return { variant: updated };
  },
);

app.get(
  "/api/pos/context",
  { preHandler: requirePermission("pos.access") },
  async (request) => {
    const shift = db
      .prepare(
        `SELECT s.*, u.name AS user_name, u.name_ar AS user_name_ar FROM shifts s JOIN users u ON u.id = s.user_id
    WHERE s.branch_id = ? AND s.status = 'open' AND u.is_super_admin=0
      AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id=u.role_id AND rp.permission='shifts.manage')
    ORDER BY s.opened_at DESC LIMIT 1`,
      )
      .get(request.user.branchId);
    const customers = db
      .prepare(
        `SELECT id, name, phone, credit_approved, credit_limit, credit_balance
    FROM customers WHERE active = 1 ORDER BY name`,
      )
      .all();
    const heldOrders = (
      db
        .prepare(
          `SELECT id, subtotal AS total, note, cart_payload, created_at FROM held_orders
    WHERE branch_id = ? ORDER BY created_at DESC`,
        )
        .all(request.user.branchId) as Array<Record<string, unknown>>
    ).map((row) => ({
      ...row,
      cart: JSON.parse(String(row.cart_payload)),
    }));
    const branch = db
      .prepare("SELECT name, name_ar, address FROM branches WHERE id = ?")
      .get(request.user.branchId);
    const receiptSetting = db
      .prepare("SELECT value FROM settings WHERE key = 'receipt'")
      .get() as { value?: string } | undefined;
    const brandSetting = db
      .prepare("SELECT value FROM settings WHERE key = 'brand'")
      .get() as { value?: string } | undefined;
    return {
      shift,
      customers,
      heldOrders,
      branch,
      receipt: JSON.parse(receiptSetting?.value ?? "{}"),
      brand: JSON.parse(brandSetting?.value ?? "{}"),
      barista: request.user.name,
      baristaAr: request.user.nameAr,
    };
  },
);

app.post(
  "/api/orders/hold",
  { preHandler: requirePermission("pos.access") },
  async (request, reply) => {
    const body = request.body as {
      shiftId?: string;
      note?: string;
      items?: unknown[];
      activityLog?: unknown[];
    };
    if (
      !body.shiftId ||
      !Array.isArray(body.items) ||
      !body.items.length
    ) {
      return reply
        .status(400)
        .send({ error: "A non-empty order and open shift are required" });
    }
    if (
      !db
        .prepare(
          "SELECT id FROM shifts WHERE id=? AND branch_id=? AND status='open'",
        )
        .get(body.shiftId, request.user.branchId)
    ) {
      return reply
        .status(409)
        .send({ error: "This branch does not have the selected open shift" });
    }
    const products = body.items as Array<{
      productId: string;
      variantId?: string | null;
      quantity: number;
      note?: string;
    }>;
    const productStatement = db.prepare(
      "SELECT id, name, name_ar, price, active FROM products p WHERE id = ? AND NOT EXISTS (SELECT 1 FROM product_branch_availability pba WHERE pba.product_id=p.id AND pba.branch_id=? AND pba.available=0)",
    );
    const verified = products.map((item) => {
      const product = productStatement.get(
        item.productId,
        request.user.branchId,
      ) as Record<string, unknown> | undefined;
      if (
        !product ||
        !product.active ||
        !Number.isInteger(item.quantity) ||
        item.quantity < 1
      ) {
        throw Object.assign(
          new Error("Held order contains an unavailable product"),
          { statusCode: 409 },
        );
      }
      const variant = item.variantId
        ? (db
            .prepare(
              "SELECT id, name, name_ar, price FROM product_variants WHERE id = ? AND product_id = ? AND active = 1",
            )
            .get(item.variantId, item.productId) as
            Record<string, unknown> | undefined)
        : undefined;
      if (item.variantId && !variant)
        throw Object.assign(
          new Error("Held order contains an unavailable option"),
          { statusCode: 409 },
        );
      return {
        productId: item.productId,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
        note: item.note ?? "",
        name: product.name,
        nameAr: product.name_ar,
        variantName: variant?.name ?? null,
        variantNameAr: variant?.name_ar ?? null,
        price: Number(variant?.price ?? product.price),
      };
    });
    const subtotal = verified.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const payload = { items: verified, activityLog: body.activityLog ?? [] };
    db.prepare(
      `INSERT INTO held_orders (id, branch_id, shift_id, user_id, cart_payload, subtotal, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      request.user.branchId,
      body.shiftId,
      request.user.sub,
      JSON.stringify(payload),
      subtotal,
      body.note ?? "",
      timestamp,
      timestamp,
    );
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "order.held",
      entityType: "held_order",
      entityId: id,
      newValue: { subtotal, itemCount: verified.length },
    });
    return reply.status(201).send({ id, subtotal, createdAt: timestamp });
  },
);

app.delete(
  "/api/orders/held/:id",
  { preHandler: requirePermission("pos.access") },
  async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const held = db
      .prepare(
        "SELECT subtotal FROM held_orders WHERE id = ? AND branch_id = ?",
      )
      .get(id, request.user.branchId) as
      { subtotal: number } | undefined;
    if (!held) return reply.status(404).send({ error: "Held order not found" });
    db.prepare("DELETE FROM held_orders WHERE id = ?").run(id);
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "order.held_cancelled",
      entityType: "held_order",
      entityId: id,
      originalValue: held,
    });
    return reply.status(204).send();
  },
);

app.post(
  "/api/orders/checkout",
  { preHandler: requirePermission("pos.access") },
  async (request, reply) => {
    const parsed = checkoutSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .status(400)
        .send({ error: "Invalid checkout", details: parsed.error.flatten() });
    const input = parsed.data;
    const existing = db
      .prepare(
        "SELECT id, order_number, total, status FROM orders WHERE client_request_id = ?",
      )
      .get(input.clientRequestId);
    if (existing) return { order: existing, idempotentReplay: true };

    try {
      const order = inTransaction(db, () => {
        const shift = db
          .prepare(
            "SELECT * FROM shifts WHERE id = ? AND branch_id = ? AND status = 'open'",
          )
          .get(input.shiftId, request.user.branchId) as
          Record<string, unknown> | undefined;
        if (!shift)
          throw Object.assign(new Error("An open shift is required"), {
            statusCode: 409,
          });
        const productLookup =
          db.prepare(`SELECT p.id, p.category_id, p.name, p.name_ar, p.price, p.cost, p.stock, p.track_stock, c.name AS category_name, c.name_ar AS category_name_ar FROM products p JOIN categories c ON c.id=p.category_id
        WHERE p.id = ? AND p.active = 1 AND NOT EXISTS (SELECT 1 FROM product_branch_availability pba WHERE pba.product_id=p.id AND pba.branch_id=? AND pba.available=0)`);
        const products = input.items.map((item) => {
          const product = productLookup.get(
            item.productId,
            request.user.branchId,
          ) as Record<string, unknown> | undefined;
          if (!product)
            throw Object.assign(
              new Error("A selected product is no longer available"),
              { statusCode: 409 },
            );
          const variant = item.variantId
            ? (db
                .prepare(
                  `SELECT id, name, name_ar, price, cost, stock, track_stock FROM product_variants
          WHERE id = ? AND product_id = ? AND active = 1`,
                )
                .get(item.variantId, item.productId) as
                Record<string, unknown> | undefined)
            : undefined;
          if (item.variantId && !variant)
            throw Object.assign(
              new Error("A selected product option is no longer available"),
              { statusCode: 409 },
            );
          if (variant?.track_stock && Number(variant.stock) < item.quantity) {
            throw Object.assign(
              new Error(
                `${product.name} · ${variant.name} has insufficient stock`,
              ),
              { statusCode: 409 },
            );
          }
          if (
            !variant?.track_stock &&
            product.track_stock &&
            Number(product.stock) < item.quantity
          ) {
            throw Object.assign(
              new Error(`${product.name} has insufficient stock`),
              { statusCode: 409 },
            );
          }
          return {
            ...item,
            product,
            variant,
            unitPrice: Number(variant?.price ?? product.price),
            unitCost: Number(variant?.cost ?? product.cost ?? 0),
          };
        });
        const subtotal = products.reduce(
          (sum, item) => sum + item.unitPrice * item.quantity,
          0,
        );
        if (
          input.discountAmount > 0 &&
          !request.user.permissions.includes("pos.discount")
        ) {
          throw Object.assign(new Error("Discount permission is required"), {
            statusCode: 403,
          });
        }
        if (input.discountAmount > subtotal)
          throw Object.assign(new Error("Discount cannot exceed subtotal"), {
            statusCode: 400,
          });
        const taxSetting = JSON.parse(
          String(
            (
              db
                .prepare("SELECT value FROM settings WHERE key = 'tax'")
                .get() as { value?: string } | undefined
            )?.value ?? "{}",
          ),
        ) as { enabled?: boolean; rate?: number; pricesIncludeTax?: boolean };
        const discounted = subtotal - input.discountAmount;
        const taxAmount =
          taxSetting.enabled && !taxSetting.pricesIncludeTax
            ? Math.round((discounted * Number(taxSetting.rate ?? 0)) / 100)
            : 0;
        const total = discounted + taxAmount;

        if (input.paymentMethod === "credit") {
          if (!input.customerId)
            throw Object.assign(
              new Error("A customer is required for credit sales"),
              { statusCode: 400 },
            );
          const customer = db
            .prepare("SELECT * FROM customers WHERE id = ? AND active = 1")
            .get(input.customerId) as Record<string, unknown> | undefined;
          if (!customer || !customer.credit_approved)
            throw Object.assign(
              new Error("Customer is not approved for credit"),
              { statusCode: 409 },
            );
          if (
            Number(customer.credit_balance) + total >
            Number(customer.credit_limit)
          ) {
            throw Object.assign(
              new Error("Customer credit limit would be exceeded"),
              { statusCode: 409 },
            );
          }
        }

        const timestamp = new Date().toISOString();
        const date = currentBusinessDate();
        const branch = db
          .prepare("SELECT code FROM branches WHERE id = ?")
          .get(request.user.branchId) as { code: string };
        db.prepare(
          `INSERT INTO daily_sequences (branch_id, business_date, last_number) VALUES (?, ?, 1)
        ON CONFLICT(branch_id, business_date) DO UPDATE SET last_number = last_number + 1`,
        ).run(request.user.branchId, date);
        const sequence = (
          db
            .prepare(
              "SELECT last_number FROM daily_sequences WHERE branch_id = ? AND business_date = ?",
            )
            .get(request.user.branchId, date) as { last_number: number }
        ).last_number;
        const orderNumber = `${date.replaceAll("-", "")}-${branch.code}-${String(sequence).padStart(4, "0")}`;
        const orderId = randomUUID();
        db.prepare(
          `INSERT INTO orders
        (id, client_request_id, order_number, branch_id, shift_id, user_id, customer_id, status, payment_method, subtotal, discount_amount, tax_amount, total, note, business_date, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          orderId,
          input.clientRequestId,
          orderNumber,
          request.user.branchId,
          input.shiftId,
          request.user.sub,
          input.customerId ?? null,
          input.paymentMethod,
          subtotal,
          input.discountAmount,
          taxAmount,
          total,
          input.note,
          date,
          timestamp,
          timestamp,
        );
        const itemInsert = db.prepare(`INSERT INTO order_items
        (id, order_id, product_id, variant_id, product_name, product_name_ar, variant_name, variant_name_ar, quantity, unit_price, unit_cost, total, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const stockUpdate = db.prepare(
          "UPDATE products SET stock = stock - ?, updated_at = ? WHERE id = ?",
        );
        const movementInsert = db.prepare(`INSERT INTO inventory_movements
        (id, product_id, variant_id, branch_id, type, quantity, before_quantity, after_quantity, reference_type, reference_id, user_id, created_at)
        VALUES (?, ?, ?, ?, 'sale', ?, ?, ?, 'order', ?, ?, ?)`);
        for (const item of products) {
          itemInsert.run(
            randomUUID(),
            orderId,
            item.productId,
            item.variantId ?? null,
            String(item.product.name),
            String(item.product.name_ar),
            item.variant ? String(item.variant.name) : null,
            item.variant ? String(item.variant.name_ar) : null,
            item.quantity,
            item.unitPrice,
            item.unitCost,
            item.unitPrice * item.quantity,
            item.note,
          );
          if (item.variant?.track_stock) {
            const before = Number(item.variant.stock);
            const after = before - item.quantity;
            const variantId = String(item.variantId);
            db.prepare(
              "UPDATE product_variants SET stock = ?, updated_at = ? WHERE id = ?",
            ).run(after, timestamp, variantId);
            movementInsert.run(
              randomUUID(),
              item.productId,
              variantId,
              request.user.branchId,
              -item.quantity,
              before,
              after,
              orderId,
              request.user.sub,
              timestamp,
            );
          } else if (item.product.track_stock) {
            const before = Number(item.product.stock);
            const after = before - item.quantity;
            stockUpdate.run(item.quantity, timestamp, item.productId);
            movementInsert.run(
              randomUUID(),
              item.productId,
              null,
              request.user.branchId,
              -item.quantity,
              before,
              after,
              orderId,
              request.user.sub,
              timestamp,
            );
          }
          const recipes = db
            .prepare(
              `SELECT rc.inventory_item_id, SUM(rc.quantity) AS quantity,
                ii.stock_quantity, ii.name AS ingredient_name
              FROM recipe_components rc
          JOIN inventory_items ii ON ii.id = rc.inventory_item_id
          WHERE rc.product_id = ?
            AND ((? IS NULL AND rc.variant_id IS NULL)
              OR rc.variant_id = ?
              OR (? IS NOT NULL AND rc.variant_id IS NULL))
          GROUP BY rc.inventory_item_id, ii.stock_quantity, ii.name`,
            )
            .all(
              item.productId,
              item.variantId ?? null,
              item.variantId ?? null,
              item.variantId ?? null,
            ) as unknown as Array<{
            inventory_item_id: string;
            quantity: number;
            stock_quantity: number;
            ingredient_name: string;
          }>;
          for (const recipe of recipes) {
            const consumed = recipe.quantity * item.quantity;
            const ingredientAfter = recipe.stock_quantity - consumed;
            db.prepare(
              "UPDATE inventory_items SET stock_quantity = ?, updated_at = ? WHERE id = ?",
            ).run(ingredientAfter, timestamp, recipe.inventory_item_id);
            db.prepare(
              `INSERT INTO inventory_item_movements
            (id, inventory_item_id, branch_id, type, quantity, before_quantity, after_quantity, reference_type, reference_id, reason, user_id, created_at)
            VALUES (?, ?, ?, 'estimated_sale_usage', ?, ?, ?, 'order', ?, ?, ?, ?)`,
            ).run(
              randomUUID(),
              recipe.inventory_item_id,
              request.user.branchId,
              -consumed,
              recipe.stock_quantity,
              ingredientAfter,
              orderId,
              `${String(item.product.name)}${item.variant ? ` · ${String(item.variant.name)}` : ""}`,
              request.user.sub,
              timestamp,
            );
          }
        }
        if (input.paymentMethod === "credit" && input.customerId) {
          db.prepare(
            "UPDATE customers SET credit_balance = credit_balance + ?, updated_at = ? WHERE id = ?",
          ).run(total, timestamp, input.customerId);
        }
        db.prepare(
          `INSERT INTO treasury_movements
        (id, branch_id, shift_id, type, amount, payment_method, reference_type, reference_id, description, user_id, created_at)
        VALUES (?, ?, ?, 'sale', ?, ?, 'order', ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          request.user.branchId,
          input.shiftId,
          total,
          input.paymentMethod,
          orderId,
          orderNumber,
          request.user.sub,
          timestamp,
        );
        const customerBalance = input.customerId
          ? (
              db
                .prepare("SELECT credit_balance FROM customers WHERE id = ?")
                .get(input.customerId) as { credit_balance: number } | undefined
            )?.credit_balance
          : null;
        const customerName = input.customerId
          ? (
              db
                .prepare("SELECT name FROM customers WHERE id=?")
                .get(input.customerId) as { name: string } | undefined
            )?.name
          : null;
        const result = {
          id: orderId,
          orderNumber,
          businessDate: date,
          branchId: request.user.branchId,
          userId: request.user.sub,
          userName: request.user.name,
          status: "completed",
          subtotal,
          discountAmount: input.discountAmount,
          taxAmount,
          total,
          paymentMethod: input.paymentMethod,
          customerId: input.customerId ?? null,
          customerName,
          createdAt: timestamp,
          customerBalance,
          items: products.map((item) => ({
            productId: item.productId,
            categoryId: String(item.product.category_id),
            categoryName: String(item.product.category_name),
            categoryNameAr: String(item.product.category_name_ar),
            variantId: item.variantId ?? null,
            name: item.product.name,
            nameAr: item.product.name_ar,
            variantName: item.variant?.name ?? null,
            variantNameAr: item.variant?.name_ar ?? null,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            unitCost: item.unitCost,
            total: item.unitPrice * item.quantity,
          })),
        };
        insertAudit(db, {
          branchId: request.user.branchId,
          userId: request.user.sub,
          action: "order.completed",
          entityType: "order",
          entityId: orderId,
          orderNumber,
          newValue: result,
          metadata: { itemCount: input.items.length },
        });
        for (const activity of input.activityLog) {
          insertAudit(db, {
            branchId: request.user.branchId,
            userId: request.user.sub,
            action: activity.action,
            entityType: "order",
            entityId: orderId,
            orderNumber,
            originalValue: activity.originalValue,
            newValue: activity.newValue,
            metadata: {
              productId: activity.productId ?? null,
              occurredAt: activity.occurredAt,
            },
          });
        }
        if (input.heldOrderId) {
          const held = db
            .prepare(
              "SELECT id FROM held_orders WHERE id = ? AND branch_id = ?",
            )
            .get(input.heldOrderId, request.user.branchId);
          if (held) {
            db.prepare("DELETE FROM held_orders WHERE id = ?").run(
              input.heldOrderId,
            );
            insertAudit(db, {
              branchId: request.user.branchId,
              userId: request.user.sub,
              action: "order.resumed",
              entityType: "order",
              entityId: orderId,
              orderNumber,
              originalValue: { heldOrderId: input.heldOrderId },
            });
          }
        }
        enqueueSync(
          db,
          request.user.branchId,
          "order",
          orderId,
          "order.completed",
          result,
        );
        return result;
      });
      return reply.status(201).send({ order, idempotentReplay: false });
    } catch (error) {
      const statusCode =
        typeof error === "object" && error && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
      return reply.status(statusCode).send({
        error: error instanceof Error ? error.message : "Checkout failed",
      });
    }
  },
);

app.get(
  "/api/orders",
  { preHandler: requireAnyPermission("sales.view", "pos.history") },
  async (request) => {
    const query = request.query as {
      limit?: string;
      status?: string;
      search?: string;
    };
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
    const conditions = ["o.branch_id = ?"];
    const params: Array<string | number | null> = [request.user.branchId];
    if (!request.user.permissions.includes("sales.view")) {
      conditions.push("o.user_id = ?");
      params.push(request.user.sub);
    }
    if (query.status === "refunded") {
      conditions.push("o.refunded_amount > 0");
    } else if (query.status && query.status !== "all") {
      conditions.push("o.status = ? AND o.refunded_amount = 0");
      params.push(query.status);
    }
    if (query.search) {
      conditions.push("(o.order_number LIKE ? OR c.name LIKE ?)");
      params.push(`%${query.search}%`, `%${query.search}%`);
    }
    const rows = db
      .prepare(
        `SELECT o.id, o.order_number, o.status, o.payment_method, o.subtotal, o.discount_amount,
    o.tax_amount, o.total, o.refunded_amount, o.created_at, o.sync_status, u.name AS user_name, u.name_ar AS user_name_ar, c.name AS customer_name
    FROM orders o JOIN users u ON u.id = o.user_id LEFT JOIN customers c ON c.id = o.customer_id
    WHERE ${conditions.join(" AND ")} ORDER BY o.created_at DESC LIMIT ?`,
      )
      .all(...params, limit);
    return {
      orders: (rows as Array<Record<string, unknown>>).map((row) => ({
        ...row,
        status: Number(row.refunded_amount) > 0 ? "refunded" : row.status,
      })),
    };
  },
);

app.get(
  "/api/orders/:id",
  { preHandler: requireAnyPermission("sales.view", "pos.history") },
  async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const ownOnly = !request.user.permissions.includes("sales.view");
    const order = db
      .prepare(
        `SELECT o.*, u.name AS user_name, u.name_ar AS user_name_ar, c.name AS customer_name FROM orders o
    JOIN users u ON u.id = o.user_id LEFT JOIN customers c ON c.id = o.customer_id
    WHERE o.id = ? AND o.branch_id = ?${ownOnly ? " AND o.user_id = ?" : ""}`,
      )
      .get(...(ownOnly ? [id, request.user.branchId, request.user.sub] : [id, request.user.branchId])) as Record<string, unknown> | undefined;
    if (!order) return reply.status(404).send({ error: "Order not found" });
    const items = db
      .prepare("SELECT * FROM order_items WHERE order_id = ?")
      .all(id);
    const history = db
      .prepare(
        "SELECT * FROM audit_logs WHERE entity_type = 'order' AND entity_id = ? ORDER BY created_at",
      )
      .all(id);
    return {
      order: {
        ...order,
        status: Number(order.refunded_amount) > 0 ? "refunded" : order.status,
        items,
        history,
      },
    };
  },
);

app.post(
  "/api/orders/:id/void",
  { preHandler: requirePermission("pos.void") },
  async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const reason = String(
      (request.body as { reason?: string }).reason ?? "",
    ).trim();
    if (reason.length < 3)
      return reply.status(400).send({ error: "A void reason is required" });
    const result = () =>
      inTransaction(db, () => {
        const order = db
          .prepare("SELECT * FROM orders WHERE id = ? AND branch_id = ?")
          .get(id, request.user.branchId) as
          Record<string, unknown> | undefined;
        if (!order)
          throw Object.assign(new Error("Order not found"), {
            statusCode: 404,
          });
        if (order.status !== "completed" || Number(order.refunded_amount) > 0)
          throw Object.assign(
            new Error("Only completed orders can be voided"),
            { statusCode: 409 },
          );
        const timestamp = new Date().toISOString();
        db.prepare(
          "UPDATE orders SET status = 'voided', void_reason = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?",
        ).run(reason, timestamp, id);
        const items = db
          .prepare(
            "SELECT product_id, variant_id, quantity FROM order_items WHERE order_id = ?",
          )
          .all(id) as Array<{
          product_id: string;
          variant_id: string | null;
          quantity: number;
        }>;
        for (const item of items) {
          const product = db
            .prepare("SELECT stock, track_stock FROM products WHERE id = ?")
            .get(item.product_id) as { stock: number; track_stock: number };
          const variant = item.variant_id
            ? (db
                .prepare(
                  "SELECT stock, track_stock FROM product_variants WHERE id = ?",
                )
                .get(item.variant_id) as
                { stock: number; track_stock: number } | undefined)
            : undefined;
          if (variant?.track_stock) {
            const after = variant.stock + item.quantity;
            db.prepare(
              "UPDATE product_variants SET stock = ?, updated_at = ? WHERE id = ?",
            ).run(after, timestamp, item.variant_id);
            db.prepare(
              `INSERT INTO inventory_movements
          (id, product_id, variant_id, branch_id, type, quantity, before_quantity, after_quantity, reference_type, reference_id, reason, user_id, created_at)
          VALUES (?, ?, ?, ?, 'void_return', ?, ?, ?, 'order', ?, ?, ?, ?)`,
            ).run(
              randomUUID(),
              item.product_id,
              item.variant_id,
              request.user.branchId,
              item.quantity,
              variant.stock,
              after,
              id,
              reason,
              request.user.sub,
              timestamp,
            );
          } else if (product.track_stock) {
            const after = product.stock + item.quantity;
            db.prepare(
              "UPDATE products SET stock = ?, updated_at = ? WHERE id = ?",
            ).run(after, timestamp, item.product_id);
            db.prepare(
              `INSERT INTO inventory_movements
          (id, product_id, variant_id, branch_id, type, quantity, before_quantity, after_quantity, reference_type, reference_id, reason, user_id, created_at)
          VALUES (?, ?, NULL, ?, 'void_return', ?, ?, ?, 'order', ?, ?, ?, ?)`,
            ).run(
              randomUUID(),
              item.product_id,
              request.user.branchId,
              item.quantity,
              product.stock,
              after,
              id,
              reason,
              request.user.sub,
              timestamp,
            );
          }
        }
        const ingredientMovements = db
          .prepare(
            `SELECT m.inventory_item_id, m.quantity, m.after_quantity FROM inventory_item_movements m
      WHERE m.reference_type = 'order' AND m.reference_id = ? AND m.type = 'estimated_sale_usage'`,
          )
          .all(id) as unknown as Array<{
          inventory_item_id: string;
          quantity: number;
          after_quantity: number;
        }>;
        for (const movement of ingredientMovements) {
          const ingredient = db
            .prepare("SELECT stock_quantity FROM inventory_items WHERE id = ?")
            .get(movement.inventory_item_id) as { stock_quantity: number };
          const restored = ingredient.stock_quantity - movement.quantity;
          db.prepare(
            "UPDATE inventory_items SET stock_quantity = ?, updated_at = ? WHERE id = ?",
          ).run(restored, timestamp, movement.inventory_item_id);
          db.prepare(
            `INSERT INTO inventory_item_movements
        (id, inventory_item_id, branch_id, type, quantity, before_quantity, after_quantity, reference_type, reference_id, reason, user_id, created_at)
        VALUES (?, ?, ?, 'void_return', ?, ?, ?, 'order', ?, ?, ?, ?)`,
          ).run(
            randomUUID(),
            movement.inventory_item_id,
            request.user.branchId,
            -movement.quantity,
            ingredient.stock_quantity,
            restored,
            id,
            reason,
            request.user.sub,
            timestamp,
          );
        }
        if (order.payment_method === "credit" && order.customer_id) {
          db.prepare(
            "UPDATE customers SET credit_balance = MAX(0, credit_balance - ?), updated_at = ? WHERE id = ?",
          ).run(Number(order.total), timestamp, String(order.customer_id));
        }
        db.prepare(
          `INSERT INTO treasury_movements
      (id, branch_id, shift_id, type, amount, payment_method, reference_type, reference_id, description, user_id, created_at)
      VALUES (?, ?, ?, 'void', ?, ?, 'order', ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          request.user.branchId,
          String(order.shift_id),
          -Number(order.total),
          String(order.payment_method),
          id,
          `Void ${String(order.order_number)}`,
          request.user.sub,
          timestamp,
        );
        insertAudit(db, {
          branchId: request.user.branchId,
          userId: request.user.sub,
          action: "order.voided",
          entityType: "order",
          entityId: id,
          orderNumber: String(order.order_number),
          originalValue: { status: "completed" },
          newValue: { status: "voided" },
          reason,
        });
        enqueueSync(db, request.user.branchId, "order", id, "order.voided", {
          id,
          reason,
          timestamp,
        });
        return {
          ...order,
          status: "voided",
          void_reason: reason,
          updated_at: timestamp,
        };
      });
    try {
      return { order: result() };
    } catch (error) {
      const status =
        typeof error === "object" && error && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
      return reply.status(status).send({
        error: error instanceof Error ? error.message : "Void failed",
      });
    }
  },
);

app.post(
  "/api/orders/:id/refund",
  { preHandler: requirePermission("pos.void") },
  async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const reason = String(
      (request.body as { reason?: string }).reason ?? "",
    ).trim();
    if (reason.length < 3)
      return reply.status(400).send({ error: "A refund reason is required" });
    try {
      const refunded = inTransaction(db, () => {
        const order = db
          .prepare("SELECT * FROM orders WHERE id=? AND branch_id=?")
          .get(id, request.user.branchId) as
          Record<string, unknown> | undefined;
        if (!order)
          throw Object.assign(new Error("Order not found"), {
            statusCode: 404,
          });
        if (order.status !== "completed" || Number(order.refunded_amount) > 0)
          throw Object.assign(
            new Error("Only an unrefunded completed order can be refunded"),
            { statusCode: 409 },
          );
        const timestamp = new Date().toISOString();
        const refundId = randomUUID();
        const amount = Number(order.total);
        db.prepare(
          "INSERT INTO refunds (id,order_id,branch_id,amount,reason,user_id,created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          refundId,
          id,
          request.user.branchId,
          amount,
          reason,
          request.user.sub,
          timestamp,
        );
        db.prepare(
          "UPDATE orders SET refunded_amount=?,updated_at=?,sync_status='pending' WHERE id=?",
        ).run(amount, timestamp, id);
        const items = db
          .prepare(
            "SELECT product_id,variant_id,quantity FROM order_items WHERE order_id=?",
          )
          .all(id) as unknown as Array<{
          product_id: string;
          variant_id: string | null;
          quantity: number;
        }>;
        for (const item of items) {
          const product = db
            .prepare("SELECT stock,track_stock FROM products WHERE id=?")
            .get(item.product_id) as { stock: number; track_stock: number };
          const variant = item.variant_id
            ? (db
                .prepare(
                  "SELECT stock,track_stock FROM product_variants WHERE id=?",
                )
                .get(item.variant_id) as
                { stock: number; track_stock: number } | undefined)
            : undefined;
          if (variant?.track_stock) {
            const after = Number(variant.stock) + item.quantity;
            db.prepare(
              "UPDATE product_variants SET stock=?,updated_at=? WHERE id=?",
            ).run(after, timestamp, item.variant_id);
            db.prepare(
              `INSERT INTO inventory_movements (id,product_id,variant_id,branch_id,type,quantity,before_quantity,after_quantity,reference_type,reference_id,reason,user_id,created_at) VALUES (?, ?, ?, ?, 'refund_return', ?, ?, ?, 'refund', ?, ?, ?, ?)`,
            ).run(
              randomUUID(),
              item.product_id,
              item.variant_id,
              request.user.branchId,
              item.quantity,
              variant.stock,
              after,
              refundId,
              reason,
              request.user.sub,
              timestamp,
            );
          } else if (product.track_stock) {
            const after = Number(product.stock) + item.quantity;
            db.prepare(
              "UPDATE products SET stock=?,updated_at=? WHERE id=?",
            ).run(after, timestamp, item.product_id);
            db.prepare(
              `INSERT INTO inventory_movements (id,product_id,variant_id,branch_id,type,quantity,before_quantity,after_quantity,reference_type,reference_id,reason,user_id,created_at) VALUES (?, ?, NULL, ?, 'refund_return', ?, ?, ?, 'refund', ?, ?, ?, ?)`,
            ).run(
              randomUUID(),
              item.product_id,
              request.user.branchId,
              item.quantity,
              product.stock,
              after,
              refundId,
              reason,
              request.user.sub,
              timestamp,
            );
          }
        }
        const ingredientMovements = db
          .prepare(
            "SELECT inventory_item_id,quantity FROM inventory_item_movements WHERE reference_type='order' AND reference_id=? AND type='estimated_sale_usage'",
          )
          .all(id) as unknown as Array<{
          inventory_item_id: string;
          quantity: number;
        }>;
        for (const movement of ingredientMovements) {
          const ingredient = db
            .prepare("SELECT stock_quantity FROM inventory_items WHERE id=?")
            .get(movement.inventory_item_id) as { stock_quantity: number };
          const restored =
            Number(ingredient.stock_quantity) - Number(movement.quantity);
          db.prepare(
            "UPDATE inventory_items SET stock_quantity=?,updated_at=? WHERE id=?",
          ).run(restored, timestamp, movement.inventory_item_id);
          db.prepare(
            `INSERT INTO inventory_item_movements (id,inventory_item_id,branch_id,type,quantity,before_quantity,after_quantity,reference_type,reference_id,reason,user_id,created_at) VALUES (?, ?, ?, 'refund_return', ?, ?, ?, 'refund', ?, ?, ?, ?)`,
          ).run(
            randomUUID(),
            movement.inventory_item_id,
            request.user.branchId,
            -Number(movement.quantity),
            ingredient.stock_quantity,
            restored,
            refundId,
            reason,
            request.user.sub,
            timestamp,
          );
        }
        if (order.payment_method === "credit" && order.customer_id) {
          db.prepare(
            "UPDATE customers SET credit_balance=MAX(0,credit_balance-?),updated_at=? WHERE id=?",
          ).run(amount, timestamp, String(order.customer_id));
        }
        db.prepare(
          `INSERT INTO treasury_movements (id,branch_id,shift_id,type,amount,payment_method,reference_type,reference_id,description,user_id,created_at) VALUES (?, ?, ?, 'refund', ?, ?, 'refund', ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          request.user.branchId,
          String(order.shift_id),
          -amount,
          String(order.payment_method),
          refundId,
          `Refund ${String(order.order_number)}`,
          request.user.sub,
          timestamp,
        );
        insertAudit(db, {
          branchId: request.user.branchId,
          userId: request.user.sub,
          action: "order.refunded",
          entityType: "order",
          entityId: id,
          orderNumber: String(order.order_number),
          originalValue: { refundedAmount: 0 },
          newValue: { refundedAmount: amount, refundId },
          reason,
        });
        enqueueSync(db, request.user.branchId, "order", id, "order.refunded", {
          id,
          refundId,
          amount,
          reason,
          timestamp,
        });
        return {
          id: refundId,
          orderId: id,
          amount,
          status: "refunded",
          createdAt: timestamp,
        };
      });
      return reply.status(201).send({ refund: refunded });
    } catch (error) {
      const status =
        typeof error === "object" && error && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
      return reply.status(status).send({
        error: error instanceof Error ? error.message : "Refund failed",
      });
    }
  },
);

app.post(
  "/api/pos/cash-drawer",
  { preHandler: requirePermission("pos.drawer") },
  async (request, reply) => {
    const body = request.body as { orderId?: string; shiftId?: string; reason?: string };
    const validOrder = body.orderId && db.prepare(
      "SELECT id FROM orders WHERE id=? AND branch_id=? AND user_id=? AND payment_method='cash'",
    ).get(body.orderId, request.user.branchId, request.user.sub);
    const validShift = body.shiftId && db.prepare(
      "SELECT id FROM shifts WHERE id=? AND branch_id=? AND user_id=? AND status='open'",
    ).get(body.shiftId, request.user.branchId, request.user.sub);
    if (!validOrder && !validShift)
      return reply.status(403).send({
        error: "The cash drawer requires your current cash transaction or open shift",
      });
    const commandUrl = process.env.CASH_DRAWER_COMMAND_URL;
    let dispatched = false;
    let hardwareError: string | null = null;
    if (commandUrl) {
      try {
        const response = await fetch(commandUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(process.env.CASH_DRAWER_COMMAND_TOKEN
              ? {
                  authorization: `Bearer ${process.env.CASH_DRAWER_COMMAND_TOKEN}`,
                }
              : {}),
          },
          body: JSON.stringify({ command: "open-drawer", branchId: request.user.branchId }),
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok)
          throw new Error(`Hardware bridge returned ${response.status}`);
        dispatched = true;
      } catch (error) {
        hardwareError =
          error instanceof Error
            ? error.message.slice(0, 200)
            : "Hardware bridge failed";
      }
    }
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "cash_drawer.opened",
      entityType: validOrder ? "order" : "shift",
      entityId: String(validOrder ? body.orderId : body.shiftId),
      orderNumber: body.orderId ?? null,
      reason: body.reason ?? "Cash transaction",
      metadata: { dispatched, hardwareError },
    });
    return {
      success: true,
      command: dispatched ? "drawer-pulse-dispatched" : "drawer-pulse-recorded",
      dispatched,
      hardwareError,
    };
  },
);

app.post(
  "/api/orders/:id/reprint",
  { preHandler: requirePermission("pos.reprint") },
  async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const order = db
      .prepare(
        "SELECT id, order_number FROM orders WHERE id = ? AND branch_id = ?",
      )
      .get(id, request.user.branchId) as
      { id: string; order_number: string } | undefined;
    if (!order) return reply.status(404).send({ error: "Order not found" });
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "receipt.reprinted",
      entityType: "order",
      entityId: id,
      orderNumber: order.order_number,
    });
    return { success: true };
  },
);

app.get(
  "/api/dashboard",
  { preHandler: requirePermission("reports.daily") },
  async (request) => {
    const today = currentBusinessDate();
    const yesterday = new Date(`${today}T12:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayDate = yesterday.toISOString().slice(0, 10);
    const summary = db
      .prepare(
        `SELECT
    COALESCE(SUM(CASE WHEN status = 'completed' THEN total-refunded_amount ELSE 0 END), 0) AS revenue,
    COUNT(CASE WHEN status = 'completed' AND refunded_amount=0 THEN 1 END) AS orders,
    COALESCE(AVG(CASE WHEN status = 'completed' AND refunded_amount=0 THEN total END), 0) AS average_order,
    COUNT(CASE WHEN status = 'voided' THEN 1 END) AS voids,
    COUNT(CASE WHEN refunded_amount>0 THEN 1 END) AS refunds,
    COALESCE(SUM(refunded_amount),0) AS refund_amount
    FROM orders WHERE branch_id = ? AND business_date = ?`,
      )
      .get(request.user.branchId, today);
    const previousRevenue = Number(
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(total-refunded_amount),0) AS value FROM orders WHERE branch_id = ? AND business_date = ? AND status = 'completed'",
          )
          .get(request.user.branchId, yesterdayDate) as { value: number }
      ).value,
    );
    const estimatedProfit = Number(
      (
        db
          .prepare(
            `SELECT COALESCE(SUM((oi.unit_price-oi.unit_cost)*oi.quantity),0) AS value
             FROM order_items oi JOIN orders o ON o.id=oi.order_id
             WHERE o.branch_id=? AND o.business_date=? AND o.status='completed' AND o.refunded_amount=0`,
          )
          .get(request.user.branchId, today) as { value: number }
      ).value,
    );
    const expensesToday = Number(
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(amount),0) AS value FROM expenses WHERE branch_id=? AND substr(created_at,1,10)=?",
          )
          .get(request.user.branchId, today) as { value: number }
      ).value,
    );
    const treasuryBalance = Number(
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(amount),0) AS value FROM treasury_movements WHERE branch_id=?",
          )
          .get(request.user.branchId) as { value: number }
      ).value,
    );
    const payments = db
      .prepare(
        `SELECT payment_method, SUM(total-refunded_amount) AS total, COUNT(CASE WHEN refunded_amount=0 THEN 1 END) AS count FROM orders
    WHERE branch_id = ? AND status = 'completed' AND business_date = ? GROUP BY payment_method`,
      )
      .all(request.user.branchId, today);
    const recentOrders = db
      .prepare(
        `SELECT o.id, o.order_number, o.total, CASE WHEN o.refunded_amount>0 THEN 'refunded' ELSE o.status END AS status, o.payment_method, o.created_at, u.name AS user_name, u.name_ar AS user_name_ar
    FROM orders o JOIN users u ON u.id = o.user_id WHERE o.branch_id = ? ORDER BY o.created_at DESC LIMIT 6`,
      )
      .all(request.user.branchId);
    const topProducts = db
      .prepare(
        `SELECT oi.product_name AS name, oi.product_name_ar AS name_ar, SUM(oi.quantity) AS quantity, SUM(oi.total) AS revenue
    FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.branch_id = ? AND o.status = 'completed' AND o.refunded_amount=0 AND o.business_date=?
    GROUP BY oi.product_id ORDER BY quantity DESC LIMIT 5`,
      )
      .all(request.user.branchId, today);
    const lowStock = db
      .prepare(
        `SELECT id, name, name_ar, stock, low_stock_at FROM products
    WHERE active = 1 AND track_stock = 1 AND stock <= low_stock_at ORDER BY stock LIMIT 8`,
      )
      .all();
    const lowIngredients = db
      .prepare(
        `SELECT id,name,name_ar,stock_quantity AS stock,low_stock_at FROM inventory_items
         WHERE branch_id=? AND active=1 AND stock_quantity<=low_stock_at ORDER BY stock_quantity LIMIT 8`,
      )
      .all(request.user.branchId);
    const activeShiftRows = db
      .prepare(
        `SELECT s.id,s.opened_at,u.name AS user_name,u.name_ar AS user_name_ar FROM shifts s
         JOIN users u ON u.id=s.user_id
         WHERE s.branch_id=? AND s.status='open' AND u.is_super_admin=0
           AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id=u.role_id AND rp.permission='shifts.manage')
         ORDER BY s.opened_at`,
      )
      .all(request.user.branchId);
    const outstandingCredit = Number(
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(credit_balance),0) AS value FROM customers WHERE active=1",
          )
          .get() as { value: number }
      ).value,
    );
    const unsyncedChanges = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS value FROM sync_outbox WHERE branch_id=? AND synced_at IS NULL",
          )
          .get(request.user.branchId) as { value: number }
      ).value,
    );
    const endDate = new Date(`${today}T12:00:00Z`);
    const dates = Array.from({ length: 7 }, (_, index) =>
      new Date(endDate.getTime() - (6 - index) * 86_400_000)
        .toISOString()
        .slice(0, 10),
    );
    const last7Rows = db
      .prepare(
        `SELECT business_date AS date, COALESCE(SUM(total-refunded_amount), 0) AS revenue, COUNT(CASE WHEN refunded_amount=0 THEN 1 END) AS orders FROM orders
    WHERE branch_id = ? AND status = 'completed' AND business_date BETWEEN ? AND ? GROUP BY business_date`,
      )
      .all(request.user.branchId, dates[0]!, dates[6]!) as unknown as Array<{
      date: string;
      revenue: number;
      orders: number;
    }>;
    const last7 = dates.map(
      (date) =>
        last7Rows.find((row) => row.date === date) ?? {
          date,
          revenue: 0,
          orders: 0,
        },
    );
    return {
      summary,
      financial: {
        previousRevenue,
        estimatedProfit,
        expensesToday,
        treasuryBalance,
      },
      operations: {
        activeShifts: activeShiftRows.length,
        activeShiftRows,
        unsyncedChanges,
        lowStockItems: lowStock.length + lowIngredients.length,
        outstandingCredit,
      },
      payments,
      recentOrders,
      topProducts,
      lowStock: [...lowStock, ...lowIngredients],
      chart: last7,
    };
  },
);

app.get(
  "/api/audit",
  { preHandler: requirePermission("audit.view") },
  async (request) => {
    const query = request.query as { action?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 300);
    const params: Array<string | number | null> = [request.user.branchId];
    let actionSql = "";
    if (query.action && query.action !== "all") {
      actionSql = "AND a.action = ?";
      params.push(query.action);
    }
    const logs = db
      .prepare(
        `SELECT a.*, u.name AS user_name, u.name_ar AS user_name_ar FROM audit_logs a
    JOIN users u ON u.id = a.user_id
    WHERE a.branch_id = ? ${actionSql} ORDER BY a.created_at DESC LIMIT ?`,
      )
      .all(...params, limit);
    return { logs };
  },
);

app.get(
  "/api/inventory",
  { preHandler: requirePermission("inventory.manage") },
  async () => ({
    products: db
      .prepare(
        `SELECT p.*, c.name AS category_name, c.name_ar AS category_name_ar FROM products p JOIN categories c ON c.id = p.category_id ORDER BY p.stock, p.name`,
      )
      .all(),
    movements: db
      .prepare(
        `SELECT m.*, p.name AS product_name, u.name AS user_name, u.name_ar AS user_name_ar FROM inventory_movements m
    JOIN products p ON p.id = m.product_id JOIN users u ON u.id = m.user_id ORDER BY m.created_at DESC LIMIT 80`,
      )
      .all(),
    ingredients: db
      .prepare("SELECT * FROM inventory_items ORDER BY stock_quantity, name")
      .all(),
    ingredientMovements: db
      .prepare(
        `SELECT m.*, i.name AS ingredient_name, i.unit, u.name AS user_name, u.name_ar AS user_name_ar FROM inventory_item_movements m
    JOIN inventory_items i ON i.id = m.inventory_item_id JOIN users u ON u.id = m.user_id ORDER BY m.created_at DESC LIMIT 100`,
      )
      .all(),
    transfers: db
      .prepare(
        `SELECT t.*,COALESCE(p.name,i.name) AS item_name,b.name AS destination_name,b.name_ar AS destination_name_ar,u.name AS user_name,u.name_ar AS user_name_ar FROM inventory_transfers t LEFT JOIN products p ON p.id=t.product_id LEFT JOIN inventory_items i ON i.id=t.inventory_item_id JOIN branches b ON b.id=t.destination_branch_id JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 100`,
      )
      .all(),
    incomingTransfers: db
      .prepare(
        `SELECT t.*,b.name AS source_name,b.name_ar AS source_name_ar FROM incoming_transfers t LEFT JOIN branches b ON b.id=t.source_branch_id ORDER BY t.received_at DESC LIMIT 100`,
      )
      .all(),
    branches: db
      .prepare(
        "SELECT id,name,name_ar FROM branches WHERE active=1 ORDER BY name",
      )
      .all(),
  }),
);

app.post(
  "/api/inventory/items",
  { preHandler: requirePermission("inventory.manage") },
  async (request, reply) => {
    const body = request.body as {
      sku?: string;
      name?: string;
      nameAr?: string;
      unit?: string;
      stockQuantity?: number;
      lowStockAt?: number;
      costPerUnit?: number;
    };
    if (
      !body.sku?.trim() ||
      !body.name?.trim() ||
      !body.nameAr?.trim() ||
      !["grams", "kilograms", "milliliters", "liters", "pieces"].includes(
        String(body.unit),
      )
    ) {
      return reply.status(400).send({
        error: "SKU, bilingual names, and a supported unit are required",
      });
    }
    if (
      ![
        body.stockQuantity ?? 0,
        body.lowStockAt ?? 0,
        body.costPerUnit ?? 0,
      ].every((value) => Number.isFinite(Number(value)) && Number(value) >= 0)
    ) {
      return reply.status(400).send({
        error: "Stock, low-stock level, and unit cost cannot be negative",
      });
    }
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    try {
      db.prepare(
        `INSERT INTO inventory_items (id, branch_id, sku, name, name_ar, unit, stock_quantity, low_stock_at, cost_per_unit, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        request.user.branchId,
        body.sku.trim().toUpperCase(),
        body.name.trim(),
        body.nameAr.trim(),
        String(body.unit),
        Number(body.stockQuantity ?? 0),
        Number(body.lowStockAt ?? 0),
        Number(body.costPerUnit ?? 0),
        timestamp,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE"))
        return reply
          .status(409)
          .send({ error: "Ingredient SKU already exists at this branch" });
      throw error;
    }
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "inventory_item.created",
      entityType: "inventory_item",
      entityId: id,
      newValue: body,
    });
    enqueueSync(
      db,
      request.user.branchId,
      "inventory_item",
      id,
      "inventory_item.created",
      { id, ...body, timestamp },
    );
    return reply.status(201).send({ id });
  },
);

app.post(
  "/api/inventory/items/:id/adjust",
  { preHandler: requirePermission("inventory.manage") },
  async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as {
      quantity?: number;
      reason?: string;
      type?: string;
    };
    const quantity = Number(body.quantity);
    const reason = body.reason?.trim();
    if (!Number.isFinite(quantity) || quantity === 0 || !reason)
      return reply
        .status(400)
        .send({ error: "Quantity and reason are required" });
    const item = db
      .prepare("SELECT * FROM inventory_items WHERE id = ? AND branch_id = ?")
      .get(id, request.user.branchId) as Record<string, unknown> | undefined;
    if (!item)
      return reply.status(404).send({ error: "Inventory item not found" });
    const after = Number(item.stock_quantity) + quantity;
    if (after < 0)
      return reply.status(400).send({ error: "Stock cannot become negative" });
    const timestamp = new Date().toISOString();
    inTransaction(db, () => {
      db.prepare(
        "UPDATE inventory_items SET stock_quantity = ?, updated_at = ? WHERE id = ?",
      ).run(after, timestamp, id);
      db.prepare(
        `INSERT INTO inventory_item_movements
      (id, inventory_item_id, branch_id, type, quantity, before_quantity, after_quantity, reference_type, reference_id, reason, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        id,
        request.user.branchId,
        body.type ?? "adjustment",
        quantity,
        Number(item.stock_quantity),
        after,
        randomUUID(),
        reason,
        request.user.sub,
        timestamp,
      );
      insertAudit(db, {
        branchId: request.user.branchId,
        userId: request.user.sub,
        action: "ingredient_stock.adjusted",
        entityType: "inventory_item",
        entityId: id,
        originalValue: { stock: item.stock_quantity },
        newValue: { stock: after },
        reason,
      });
      enqueueSync(
        db,
        request.user.branchId,
        "inventory_item",
        id,
        "ingredient_stock.adjusted",
        { id, quantity, after, reason, timestamp },
      );
    });
    return { stockQuantity: after };
  },
);

app.post(
  "/api/inventory/:id/adjust",
  { preHandler: requirePermission("inventory.manage") },
  async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as {
      quantity?: number;
      reason?: string;
      type?: string;
    };
    const adjustmentQuantity = Number(body.quantity);
    const adjustmentReason = body.reason?.trim();
    if (!Number.isInteger(adjustmentQuantity) || !adjustmentReason)
      return reply
        .status(400)
        .send({ error: "Quantity and reason are required" });
    const product = db
      .prepare("SELECT id, stock FROM products WHERE id = ?")
      .get(id) as { id: string; stock: number } | undefined;
    if (!product) return reply.status(404).send({ error: "Product not found" });
    const after = product.stock + adjustmentQuantity;
    if (after < 0)
      return reply.status(400).send({ error: "Stock cannot become negative" });
    const timestamp = new Date().toISOString();
    inTransaction(db, () => {
      db.prepare(
        "UPDATE products SET stock = ?, updated_at = ? WHERE id = ?",
      ).run(after, timestamp, id);
      db.prepare(
        `INSERT INTO inventory_movements
      (id, product_id, branch_id, type, quantity, before_quantity, after_quantity, reference_type, reference_id, reason, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        id,
        request.user.branchId,
        body.type ?? "adjustment",
        adjustmentQuantity,
        product.stock,
        after,
        randomUUID(),
        adjustmentReason,
        request.user.sub,
        timestamp,
      );
      insertAudit(db, {
        branchId: request.user.branchId,
        userId: request.user.sub,
        action: "inventory.adjusted",
        entityType: "product",
        entityId: id,
        originalValue: { stock: product.stock },
        newValue: { stock: after },
        reason: adjustmentReason,
      });
      enqueueSync(
        db,
        request.user.branchId,
        "product",
        id,
        "inventory.adjusted",
        { productId: id, quantity: adjustmentQuantity, after, timestamp },
      );
    });
    return { stock: after };
  },
);

app.post(
  "/api/inventory/transfers",
  { preHandler: requirePermission("inventory.manage") },
  async (request, reply) => {
    const body = request.body as {
      itemType?: "product" | "ingredient";
      itemId?: string;
      destinationBranchId?: string;
      quantity?: number;
      reason?: string;
    };
    const quantity = Number(body.quantity);
    const reason = body.reason?.trim();
    if (
      !["product", "ingredient"].includes(String(body.itemType)) ||
      !body.itemId ||
      !body.destinationBranchId ||
      body.destinationBranchId === request.user.branchId ||
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      !reason
    )
      return reply.status(400).send({
        error:
          "Item, another destination branch, positive quantity, and reason are required",
      });
    const itemId = String(body.itemId);
    const destinationBranchId = String(body.destinationBranchId);
    const itemType = body.itemType as "product" | "ingredient";
    if (
      !db
        .prepare("SELECT id FROM branches WHERE id=? AND active=1")
        .get(destinationBranchId)
    )
      return reply
        .status(404)
        .send({ error: "Destination branch not found or disabled" });
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    try {
      const transfer = inTransaction(db, () => {
        if (itemType === "product") {
          if (!Number.isInteger(quantity))
            throw Object.assign(
              new Error(
                "Packaged-product transfer quantity must be a whole number",
              ),
              { statusCode: 400 },
            );
          const item = db
            .prepare(
              "SELECT id,sku,name,name_ar,stock,track_stock FROM products WHERE id=? AND active=1",
            )
            .get(itemId) as Record<string, unknown> | undefined;
          if (!item || !item.track_stock)
            throw Object.assign(new Error("Tracked product not found"), {
              statusCode: 404,
            });
          if (Number(item.stock) < quantity)
            throw Object.assign(new Error("Insufficient stock for transfer"), {
              statusCode: 409,
            });
          const after = Number(item.stock) - quantity;
          db.prepare("UPDATE products SET stock=?,updated_at=? WHERE id=?").run(
            after,
            timestamp,
            itemId,
          );
          db.prepare(
            `INSERT INTO inventory_movements (id,product_id,branch_id,type,quantity,before_quantity,after_quantity,reference_type,reference_id,reason,user_id,created_at) VALUES (?, ?, ?, 'transfer_out', ?, ?, ?, 'transfer', ?, ?, ?, ?)`,
          ).run(
            randomUUID(),
            itemId,
            request.user.branchId,
            -quantity,
            Number(item.stock),
            after,
            id,
            reason,
            request.user.sub,
            timestamp,
          );
          db.prepare(
            `INSERT INTO inventory_transfers (id,source_branch_id,destination_branch_id,item_type,product_id,quantity,unit,reason,user_id,created_at) VALUES (?, ?, ?, 'product', ?, ?, 'pieces', ?, ?, ?)`,
          ).run(
            id,
            request.user.branchId,
            destinationBranchId,
            itemId,
            quantity,
            reason,
            request.user.sub,
            timestamp,
          );
          return {
            id,
            itemType: "product",
            itemId,
            sku: item.sku,
            name: item.name,
            nameAr: item.name_ar,
            quantity,
            unit: "pieces",
            after,
          };
        }
        const item = db
          .prepare(
            "SELECT id,sku,name,name_ar,unit,stock_quantity,low_stock_at,cost_per_unit FROM inventory_items WHERE id=? AND branch_id=? AND active=1",
          )
          .get(itemId, request.user.branchId) as
          Record<string, unknown> | undefined;
        if (!item)
          throw Object.assign(new Error("Ingredient not found"), {
            statusCode: 404,
          });
        if (Number(item.stock_quantity) < quantity)
          throw Object.assign(
            new Error("Insufficient ingredient stock for transfer"),
            { statusCode: 409 },
          );
        const after = Number(item.stock_quantity) - quantity;
        db.prepare(
          "UPDATE inventory_items SET stock_quantity=?,updated_at=? WHERE id=?",
        ).run(after, timestamp, itemId);
        db.prepare(
          `INSERT INTO inventory_item_movements (id,inventory_item_id,branch_id,type,quantity,before_quantity,after_quantity,reference_type,reference_id,reason,user_id,created_at) VALUES (?, ?, ?, 'transfer_out', ?, ?, ?, 'transfer', ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          itemId,
          request.user.branchId,
          -quantity,
          Number(item.stock_quantity),
          after,
          id,
          reason,
          request.user.sub,
          timestamp,
        );
        db.prepare(
          `INSERT INTO inventory_transfers (id,source_branch_id,destination_branch_id,item_type,inventory_item_id,quantity,unit,reason,user_id,created_at) VALUES (?, ?, ?, 'ingredient', ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          request.user.branchId,
          destinationBranchId,
          itemId,
          quantity,
          String(item.unit),
          reason,
          request.user.sub,
          timestamp,
        );
        return {
          id,
          itemType: "ingredient",
          itemId,
          sku: item.sku,
          name: item.name,
          nameAr: item.name_ar,
          quantity,
          unit: item.unit,
          lowStockAt: item.low_stock_at,
          costPerUnit: item.cost_per_unit,
          after,
        };
      });
      const payload = {
        ...transfer,
        sourceBranchId: request.user.branchId,
        destinationBranchId,
        reason,
        status: "dispatched",
        timestamp,
      };
      insertAudit(db, {
        branchId: request.user.branchId,
        userId: request.user.sub,
        action: "inventory.transfer_dispatched",
        entityType: "inventory_transfer",
        entityId: id,
        newValue: payload,
        reason,
      });
      enqueueSync(
        db,
        request.user.branchId,
        "inventory_transfer",
        id,
        "inventory.transfer_dispatched",
        payload,
      );
      return reply.status(201).send({ transfer: payload });
    } catch (error) {
      const status =
        typeof error === "object" && error && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
      return reply.status(status).send({
        error: error instanceof Error ? error.message : "Transfer failed",
      });
    }
  },
);

app.get(
  "/api/customers",
  { preHandler: requirePermission("customers.manage") },
  async () => ({
    customers: db
      .prepare("SELECT * FROM customers WHERE active = 1 ORDER BY name")
      .all(),
  }),
);

app.get(
  "/api/customers/:id/profile",
  { preHandler: requirePermission("customers.manage") },
  async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const customer = db
      .prepare(
        `SELECT c.*,
    COALESCE((SELECT SUM(total-refunded_amount) FROM orders WHERE customer_id = c.id AND status = 'completed'),0) AS historical_purchases,
    (SELECT MAX(created_at) FROM orders WHERE customer_id = c.id) AS last_transaction
    FROM customers c WHERE c.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!customer)
      return reply.status(404).send({ error: "Customer not found" });
    const transactions = db
      .prepare(
        `SELECT id, order_number, total-refunded_amount AS total, payment_method, CASE WHEN refunded_amount>0 THEN 'refunded' ELSE status END AS status, created_at
    FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100`,
      )
      .all(id);
    const payments = db
      .prepare(
        `SELECT id, amount, payment_method, description, created_at FROM treasury_movements
    WHERE reference_type = 'customer' AND reference_id = ? AND type = 'credit_payment' ORDER BY created_at DESC`,
      )
      .all(id);
    return {
      customer: rowBoolean(customer, ["credit_approved", "active"]),
      transactions,
      payments,
    };
  },
);

app.patch(
  "/api/customers/:id",
  { preHandler: requirePermission("customers.manage") },
  async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as {
      notes?: string;
      creditLimit?: number;
      creditApproved?: boolean;
      active?: boolean;
    };
    const existing = db
      .prepare("SELECT * FROM customers WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!existing)
      return reply.status(404).send({ error: "Customer not found" });
    const limit = Number(body.creditLimit ?? existing.credit_limit);
    if (!Number.isInteger(limit) || limit < 0)
      return reply
        .status(400)
        .send({ error: "Credit limit must be a non-negative EGP amount" });
    const timestamp = new Date().toISOString();
    db.prepare(
      "UPDATE customers SET notes = ?, credit_limit = ?, credit_approved = ?, active = ?, updated_at = ? WHERE id = ?",
    ).run(
      body.notes ?? String(existing.notes),
      limit,
      Number(body.creditApproved ?? Boolean(existing.credit_approved)),
      Number(body.active ?? Boolean(existing.active)),
      timestamp,
      id,
    );
    const updated = db.prepare("SELECT * FROM customers WHERE id = ?").get(id);
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "customer.updated",
      entityType: "customer",
      entityId: id,
      originalValue: existing,
      newValue: updated,
    });
    enqueueSync(db, request.user.branchId, "customer", id, "customer.updated", {
      id,
      ...body,
      timestamp,
    });
    return { customer: updated };
  },
);

app.post(
  "/api/customers",
  { preHandler: requirePermission("customers.manage") },
  async (request, reply) => {
    const body = request.body as {
      name?: string;
      phone?: string;
      email?: string;
      creditApproved?: boolean;
      creditLimit?: number;
    };
    if (!body.name?.trim())
      return reply.status(400).send({ error: "Customer name is required" });
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    db.prepare(
      `INSERT INTO customers (id, name, phone, email, credit_approved, credit_limit, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      body.name.trim(),
      body.phone ?? "",
      body.email ?? "",
      body.creditApproved ? 1 : 0,
      body.creditLimit ?? 0,
      timestamp,
      timestamp,
    );
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "customer.created",
      entityType: "customer",
      entityId: id,
      newValue: body,
    });
    enqueueSync(db, request.user.branchId, "customer", id, "customer.created", {
      id,
      ...body,
      timestamp,
    });
    return reply.status(201).send({ id });
  },
);

app.post(
  "/api/customers/:id/payment",
  { preHandler: requirePermission("credit.manage") },
  async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as {
      amount?: number;
      paymentMethod?: "cash" | "card";
      note?: string;
    };
    const amount = Number(body.amount);
    if (
      !Number.isInteger(amount) ||
      amount <= 0 ||
      !["cash", "card"].includes(String(body.paymentMethod))
    )
      return reply
        .status(400)
        .send({ error: "A valid amount and payment method are required" });
    const customer = db
      .prepare("SELECT * FROM customers WHERE id = ? AND active = 1")
      .get(id) as Record<string, unknown> | undefined;
    if (!customer)
      return reply.status(404).send({ error: "Customer not found" });
    if (amount > Number(customer.credit_balance))
      return reply
        .status(400)
        .send({ error: "Payment exceeds the outstanding balance" });
    const timestamp = new Date().toISOString();
    const movementId = randomUUID();
    const activeShift = db
      .prepare(
        "SELECT id FROM shifts WHERE branch_id=? AND status='open' ORDER BY opened_at DESC LIMIT 1",
      )
      .get(request.user.branchId) as
      { id: string } | undefined;
    inTransaction(db, () => {
      db.prepare(
        "UPDATE customers SET credit_balance = credit_balance - ?, updated_at = ? WHERE id = ?",
      ).run(amount, timestamp, id);
      db.prepare(
        `INSERT INTO treasury_movements
        (id, branch_id, shift_id, type, amount, payment_method, reference_type, reference_id, description, user_id, created_at)
      VALUES (?, ?, ?, 'credit_payment', ?, ?, 'customer', ?, ?, ?, ?)`,
      ).run(
        movementId,
        request.user.branchId,
        activeShift?.id ?? null,
        amount,
        String(body.paymentMethod),
        id,
        body.note ?? `Credit payment from ${String(customer.name)}`,
        request.user.sub,
        timestamp,
      );
      insertAudit(db, {
        branchId: request.user.branchId,
        userId: request.user.sub,
        action: "customer.credit_payment",
        entityType: "customer",
        entityId: id,
        originalValue: { balance: customer.credit_balance },
        newValue: { balance: Number(customer.credit_balance) - amount },
        metadata: { amount, paymentMethod: body.paymentMethod },
      });
      enqueueSync(
        db,
        request.user.branchId,
        "customer",
        id,
        "customer.credit_payment",
        {
          customerId: id,
          movementId,
          amount,
          paymentMethod: body.paymentMethod,
          balance: Number(customer.credit_balance) - amount,
          timestamp,
        },
      );
    });
    return { balance: Number(customer.credit_balance) - amount };
  },
);

app.get(
  "/api/staff",
  { preHandler: requirePermission("staff.manage") },
  async () => {
    const users = (
      db
        .prepare(
          `SELECT u.id, u.name, u.name_ar, u.username, u.phone, u.employment_start, u.monthly_salary, u.active, u.is_super_admin, u.role_id, r.name AS role_name, r.name_ar AS role_name_ar
    FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.active=1 ORDER BY u.name`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      ...rowBoolean(row, ["active", "is_super_admin"]),
      permissions: userPermissions(
        String(row.id),
        row.role_id ? String(row.role_id) : null,
      ),
    }));
    return {
      users,
      roles: db
        .prepare(
          `SELECT r.*, GROUP_CONCAT(rp.permission) AS permissions FROM roles r
      LEFT JOIN role_permissions rp ON rp.role_id = r.id GROUP BY r.id ORDER BY r.name`,
        )
        .all(),
      branches: db
        .prepare(
          "SELECT id, name, name_ar FROM branches WHERE active = 1 AND system_branch = 0 ORDER BY name",
        )
        .all(),
      permissions,
    };
  },
);

app.get(
  "/api/branches",
  { preHandler: requirePermission("branches.manage") },
  async () => ({
    cloudManaged: cloudServer,
    branches: (
      db
        .prepare(
          `SELECT b.*, COUNT(DISTINCT u.id) AS staff
    FROM branches b LEFT JOIN users u ON u.branch_id = b.id
    WHERE b.system_branch = 0 GROUP BY b.id ORDER BY b.created_at`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => rowBoolean(row, ["active"])),
  }),
);

app.post(
  "/api/branches",
  { preHandler: requirePermission("branches.manage") },
  async (request, reply) => {
    if (!cloudServer)
      return reply.status(400).send({
        error: "Branches are created in Cloud Admin, then paired to Windows",
      });
    const body = request.body as {
      code?: string;
      name?: string;
      nameAr?: string;
      address?: string;
      phone?: string;
      notes?: string;
      receiptInfo?: string;
    };
    if (!body.code?.trim() || !body.name?.trim() || !body.nameAr?.trim())
      return reply
        .status(400)
        .send({ error: "Code and bilingual names are required" });
    const branchCode = body.code.trim().toUpperCase();
    const branchName = body.name.trim();
    const branchNameAr = body.nameAr.trim();
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    try {
      db.prepare(
        "INSERT INTO branches (id, code, name, name_ar, address, phone, notes, receipt_info, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        branchCode,
        branchName,
        branchNameAr,
        body.address ?? "",
        body.phone ?? "",
        body.notes ?? "",
        body.receiptInfo ?? "",
        timestamp,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE"))
        return reply.status(409).send({ error: "Branch code already exists" });
      throw error;
    }
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "branch.created",
      entityType: "branch",
      entityId: id,
      newValue: body,
    });
    enqueueSync(db, request.user.branchId, "branch", id, "branch.created", {
      id,
      ...body,
      timestamp,
    });
    return reply.status(201).send({ id });
  },
);

app.post(
  "/api/branches/:id/pairing-code",
  { preHandler: requirePermission("branches.manage") },
  async (request, reply) => {
    if (process.env.CLOUD_RECEIVER_ENABLED !== "true")
      return reply
        .status(400)
        .send({ error: "Pairing codes are created on the cloud server" });
    const branchId = (request.params as { id: string }).id;
    const branch = db
      .prepare("SELECT id,code,name,name_ar,active FROM branches WHERE id=? AND system_branch=0")
      .get(branchId) as Record<string, unknown> | undefined;
    if (!branch) return reply.status(404).send({ error: "Branch not found" });
    if (!branch.active)
      return reply.status(400).send({ error: "Enable the branch before pairing" });
    const raw = randomBytes(8).toString("hex").toUpperCase();
    const code = raw.match(/.{1,4}/g)!.join("-");
    const timestamp = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    inTransaction(db, () => {
      db.prepare(
        "UPDATE branch_pairing_codes SET used_at=? WHERE branch_id=? AND used_at IS NULL",
      ).run(timestamp, branchId);
      db.prepare(
        `INSERT INTO branch_pairing_codes
         (id,branch_id,code_hash,expires_at,created_by,created_at)
         VALUES (?,?,?,?,?,?)`,
      ).run(
        randomUUID(),
        branchId,
        tokenDigest(raw),
        expiresAt,
        request.user.sub,
        timestamp,
      );
      insertAudit(db, {
        branchId: request.user.branchId,
        userId: request.user.sub,
        action: "branch.pairing_code_created",
        entityType: "branch",
        entityId: branchId,
        metadata: { expiresAt },
      });
    });
    return { code, expiresAt, branch };
  },
);

app.patch(
  "/api/branches/:id",
  { preHandler: requirePermission("branches.manage") },
  async (request, reply) => {
    if (!cloudServer)
      return reply.status(400).send({ error: "Branches are managed in Cloud Admin" });
    const id = (request.params as { id: string }).id;
    const body = request.body as {
      name?: string;
      nameAr?: string;
      address?: string;
      phone?: string;
      notes?: string;
      receiptInfo?: string;
      active?: boolean;
    };
    const existing = db
      .prepare("SELECT * FROM branches WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!existing) return reply.status(404).send({ error: "Branch not found" });
    if (id === request.user.branchId && body.active === false)
      return reply
        .status(400)
        .send({ error: "The active session branch cannot disable itself" });
    const timestamp = new Date().toISOString();
    db.prepare(
      `UPDATE branches SET name = ?, name_ar = ?, address = ?, phone = ?, notes = ?, receipt_info = ?, active = ? WHERE id = ?`,
    ).run(
      body.name?.trim() ?? String(existing.name),
      body.nameAr?.trim() ?? String(existing.name_ar),
      body.address ?? String(existing.address),
      body.phone ?? String(existing.phone),
      body.notes ?? String(existing.notes),
      body.receiptInfo ?? String(existing.receipt_info),
      Number(body.active ?? Boolean(existing.active)),
      id,
    );
    const updated = db.prepare("SELECT * FROM branches WHERE id = ?").get(id);
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "branch.updated",
      entityType: "branch",
      entityId: id,
      originalValue: existing,
      newValue: updated,
    });
    enqueueSync(db, request.user.branchId, "branch", id, "branch.updated", {
      ...(updated as object),
      timestamp,
    });
    return { branch: updated };
  },
);

app.post(
  "/api/roles",
  { preHandler: requirePermission("staff.manage") },
  async (request, reply) => {
    const body = request.body as {
      name?: string;
      nameAr?: string;
      description?: string;
      permissions?: string[];
    };
    if (!body.name?.trim() || !body.nameAr?.trim())
      return reply
        .status(400)
        .send({ error: "Bilingual role names are required" });
    const requested = [...new Set(body.permissions ?? [])];
    if (
      requested.some(
        (permission) => !permissions.includes(permission as Permission),
      )
    )
      return reply.status(400).send({ error: "Unknown permission" });
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    inTransaction(db, () => {
      db.prepare(
        "INSERT INTO roles (id, name, name_ar, description, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        id,
        body.name!.trim(),
        body.nameAr!.trim(),
        body.description ?? "",
        timestamp,
      );
      const insert = db.prepare(
        "INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)",
      );
      requested.forEach((permission) => insert.run(id, permission));
      insertAudit(db, {
        branchId: request.user.branchId,
        userId: request.user.sub,
        action: "role.created",
        entityType: "role",
        entityId: id,
        newValue: body,
      });
      enqueueSync(db, request.user.branchId, "role", id, "role.created", {
        id,
        ...body,
        timestamp,
      });
    });
    return reply.status(201).send({ id });
  },
);

app.patch(
  "/api/roles/:id",
  { preHandler: requirePermission("staff.manage") },
  async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as {
      name?: string;
      nameAr?: string;
      description?: string;
      permissions?: string[];
    };
    const existing = db.prepare("SELECT * FROM roles WHERE id=?").get(id) as
      Record<string, unknown> | undefined;
    if (!existing) return reply.status(404).send({ error: "Role not found" });
    if (existing.system_role)
      return reply
        .status(403)
        .send({ error: "Built-in roles cannot be modified" });
    if (
      (body.name !== undefined && !body.name.trim()) ||
      (body.nameAr !== undefined && !body.nameAr.trim())
    )
      return reply.status(400).send({ error: "Role names cannot be blank" });
    const requested = [...new Set(body.permissions ?? [])];
    if (
      requested.some(
        (permission) => !permissions.includes(permission as Permission),
      )
    )
      return reply.status(400).send({ error: "Unknown permission" });
    const originalPermissions = db
      .prepare("SELECT permission FROM role_permissions WHERE role_id=?")
      .all(id) as unknown as Array<{ permission: string }>;
    try {
      inTransaction(db, () => {
        db.prepare(
          "UPDATE roles SET name=?,name_ar=?,description=? WHERE id=?",
        ).run(
          body.name?.trim() ?? String(existing.name),
          body.nameAr?.trim() ?? String(existing.name_ar),
          body.description ?? String(existing.description),
          id,
        );
        if (body.permissions) {
          db.prepare("DELETE FROM role_permissions WHERE role_id=?").run(id);
          const insert = db.prepare(
            "INSERT INTO role_permissions (role_id,permission) VALUES (?, ?)",
          );
          requested.forEach((permission) => insert.run(id, permission));
        }
        insertAudit(db, {
          branchId: request.user.branchId,
          userId: request.user.sub,
          action: "role.updated",
          entityType: "role",
          entityId: id,
          originalValue: {
            ...existing,
            permissions: originalPermissions.map((row) => row.permission),
          },
          newValue: body,
        });
        enqueueSync(db, request.user.branchId, "role", id, "role.updated", {
          id,
          ...body,
          timestamp: new Date().toISOString(),
        });
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE"))
        return reply.status(409).send({ error: "Role name already exists" });
      throw error;
    }
    return { success: true };
  },
);

app.post(
  "/api/staff",
  { preHandler: requirePermission("staff.manage") },
  async (request, reply) => {
    const body = request.body as {
      name?: string;
      nameAr?: string;
      username?: string;
      password?: string;
      roleId?: string;
      branchId?: string;
      phone?: string;
      employmentStart?: string;
      monthlySalary?: number;
    };
    if (
      !body.name?.trim() ||
      !body.nameAr?.trim() ||
      !body.username?.trim() ||
      !body.password ||
      body.password.length < 10
    ) {
      return reply.status(400).send({
        error:
          "Names, username, and a password of at least 10 characters are required",
      });
    }
    if (
      body.roleId &&
      !db.prepare("SELECT id FROM roles WHERE id = ?").get(body.roleId)
    )
      return reply.status(400).send({ error: "Role not found" });
    const employeeBranchId = body.branchId ?? request.user.branchId;
    if (
      !db
        .prepare("SELECT id FROM branches WHERE id = ? AND active = 1")
        .get(employeeBranchId)
    )
      return reply.status(400).send({ error: "Branch not found or disabled" });
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    try {
      db.prepare(
        `INSERT INTO users (id, branch_id, role_id, name, name_ar, username, phone, employment_start, monthly_salary, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        employeeBranchId,
        body.roleId ?? null,
        body.name.trim(),
        body.nameAr.trim(),
        body.username.trim(),
        body.phone ?? "",
        body.employmentStart ?? timestamp.slice(0, 10),
        Number(body.monthlySalary ?? 0),
        bcrypt.hashSync(body.password, 12),
        timestamp,
        timestamp,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE"))
        return reply.status(409).send({ error: "Username already exists" });
      throw error;
    }
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "staff.created",
      entityType: "user",
      entityId: id,
      newValue: { name: body.name, username: body.username, roleId: body.roleId },
    });
    enqueueSync(db, request.user.branchId, "user", id, "staff.created", {
      id,
      name: body.name,
      nameAr: body.nameAr,
      username: body.username,
      roleId: body.roleId,
      timestamp,
    });
    return reply.status(201).send({ id });
  },
);

app.put(
  "/api/staff/:id/permissions",
  { preHandler: requirePermission("staff.manage") },
  async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as {
      roleId?: string | null;
      overrides?: Record<string, boolean>;
    };
    const target = db
      .prepare("SELECT id, role_id, is_super_admin FROM users WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!target) return reply.status(404).send({ error: "User not found" });
    if (target.is_super_admin)
      return reply
        .status(403)
        .send({ error: "Super Admin access cannot be reduced" });
    const overrides = Object.entries(body.overrides ?? {});
    if (
      overrides.some(
        ([permission]) => !permissions.includes(permission as Permission),
      )
    )
      return reply.status(400).send({ error: "Unknown permission" });
    inTransaction(db, () => {
      db.prepare(
        "UPDATE users SET role_id = ?, updated_at = ? WHERE id = ?",
      ).run(body.roleId ?? null, new Date().toISOString(), id);
      db.prepare("DELETE FROM user_permissions WHERE user_id = ?").run(id);
      const insert = db.prepare(
        "INSERT INTO user_permissions (user_id, permission, allowed) VALUES (?, ?, ?)",
      );
      overrides.forEach(([permission, allowed]) =>
        insert.run(id, permission, Number(allowed)),
      );
      insertAudit(db, {
        branchId: request.user.branchId,
        userId: request.user.sub,
        action: "staff.permissions_changed",
        entityType: "user",
        entityId: id,
        originalValue: { roleId: target.role_id },
        newValue: body,
      });
      enqueueSync(
        db,
        request.user.branchId,
        "user",
        id,
        "staff.permissions_changed",
        { id, ...body, timestamp: new Date().toISOString() },
      );
    });
    return { success: true };
  },
);

app.get(
  "/api/staff/:id/profile",
  { preHandler: requireAnyPermission("staff.manage", "payroll.view") },
  async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = db
      .prepare(
        `SELECT u.id, u.name, u.name_ar, u.username, u.phone, u.employment_start, u.monthly_salary,
    u.active, u.is_super_admin, u.branch_id, r.name AS role_name, r.name_ar AS role_name_ar, b.name AS branch_name, b.name_ar AS branch_name_ar
    FROM users u LEFT JOIN roles r ON r.id = u.role_id JOIN branches b ON b.id = u.branch_id WHERE u.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!user) return reply.status(404).send({ error: "Employee not found" });
    const month = currentBusinessDate().slice(0, 7);
    const ledger = db
      .prepare(
        `SELECT l.*, creator.name AS created_by_name, creator.name_ar AS created_by_name_ar FROM staff_ledger l JOIN users creator ON creator.id = l.created_by
    WHERE l.user_id = ? ORDER BY l.effective_date DESC, l.created_at DESC`,
      )
      .all(id) as unknown as Array<{
      type: string;
      amount: number;
      effective_date: string;
    }>;
    const currentLedger = ledger.filter((entry) =>
      entry.effective_date.startsWith(month),
    );
    const amountFor = (type: string) =>
      currentLedger
        .filter((entry) => entry.type === type)
        .reduce((sum, entry) => sum + entry.amount, 0);
    const salary = Number(user.monthly_salary);
    const calculation = {
      month,
      salary,
      advances: amountFor("advance"),
      deductions: amountFor("deduction"),
      bonuses: amountFor("bonus"),
      salaryPaid: amountFor("salary_payment"),
      employeeOwes: amountFor("employee_owes"),
      businessOwes: amountFor("business_owes"),
    };
    const remainingSalary =
      salary +
      calculation.bonuses +
      calculation.businessOwes -
      calculation.deductions -
      calculation.advances -
      calculation.salaryPaid;
    const operations = db
      .prepare(
        `SELECT COUNT(CASE WHEN status='completed' AND refunded_amount=0 THEN 1 END) AS transactions,
    COALESCE(SUM(CASE WHEN status = 'completed' THEN total-refunded_amount ELSE 0 END),0) AS sales,
    COUNT(CASE WHEN status = 'voided' THEN 1 END) AS voids,
    COUNT(CASE WHEN refunded_amount>0 THEN 1 END) AS refunds,
    COALESCE(SUM(CASE WHEN refunded_amount=0 THEN discount_amount ELSE 0 END),0) AS discounts,
    COALESCE(SUM(CASE WHEN status='completed' AND payment_method='cash' THEN total-refunded_amount ELSE 0 END),0) AS cashHandled
    FROM orders WHERE user_id = ? AND business_date LIKE ?`,
      )
      .get(id, `${month}%`);
    const daysWorked = (
      db
        .prepare(
          "SELECT COUNT(DISTINCT substr(opened_at,1,10)) AS count FROM shifts WHERE user_id = ? AND substr(opened_at,1,7) = ?",
        )
        .get(id, month) as { count: number }
    ).count;
    const drawerOpenings = (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_logs WHERE user_id = ? AND action = 'cash_drawer.opened' AND substr(created_at,1,7) = ?",
        )
        .get(id, month) as { count: number }
    ).count;
    const recentAudit = db
      .prepare(
        "SELECT * FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
      )
      .all(id);
    return {
      user: rowBoolean(user, ["active", "is_super_admin"]),
      ledger,
      calculation: { ...calculation, remainingSalary },
      operations: { ...(operations as object), daysWorked, drawerOpenings },
      recentAudit,
    };
  },
);

app.patch(
  "/api/staff/:id/employment",
  { preHandler: requireAnyPermission("staff.manage", "payroll.view") },
  async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as {
      phone?: string;
      employmentStart?: string;
      monthlySalary?: number;
      branchId?: string;
    };
    const existing = db
      .prepare(
        "SELECT phone, employment_start, monthly_salary, branch_id FROM users WHERE id = ?",
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!existing)
      return reply.status(404).send({ error: "Employee not found" });
    const salary = Number(body.monthlySalary ?? existing.monthly_salary);
    if (!Number.isInteger(salary) || salary < 0)
      return reply
        .status(400)
        .send({ error: "Salary must be a non-negative EGP amount" });
    const branchId = body.branchId ?? String(existing.branch_id);
    if (
      !db
        .prepare("SELECT id FROM branches WHERE id = ? AND active = 1")
        .get(branchId)
    )
      return reply.status(400).send({ error: "Branch not found or disabled" });
    const timestamp = new Date().toISOString();
    db.prepare(
      "UPDATE users SET phone = ?, employment_start = ?, monthly_salary = ?, branch_id = ?, updated_at = ? WHERE id = ?",
    ).run(
      body.phone ?? String(existing.phone),
      body.employmentStart ?? String(existing.employment_start ?? ""),
      salary,
      branchId,
      timestamp,
      id,
    );
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "staff.salary_modified",
      entityType: "user",
      entityId: id,
      originalValue: existing,
      newValue: body,
    });
    enqueueSync(
      db,
      request.user.branchId,
      "user",
      id,
      "staff.employment_updated",
      { id, ...body, monthlySalary: salary, timestamp },
    );
    return { success: true };
  },
);

app.post(
  "/api/staff/:id/ledger",
  { preHandler: requireAnyPermission("staff.manage", "payroll.view") },
  async (request, reply) => {
    const userId = (request.params as { id: string }).id;
    const body = request.body as {
      type?: string;
      amount?: number;
      note?: string;
      effectiveDate?: string;
    };
    const allowed = [
      "advance",
      "deduction",
      "bonus",
      "salary_payment",
      "employee_owes",
      "business_owes",
      "leave",
    ];
    const amount = Number(body.amount ?? 0);
    const note = body.note?.trim();
    if (
      !allowed.includes(String(body.type)) ||
      !Number.isInteger(amount) ||
      amount < 0 ||
      !note
    )
      return reply
        .status(400)
        .send({ error: "Type, non-negative amount, and note are required" });
    if (!db.prepare("SELECT id FROM users WHERE id = ?").get(userId))
      return reply.status(404).send({ error: "Employee not found" });
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const effectiveDate = body.effectiveDate ?? currentBusinessDate();
    const activeShift = db
      .prepare(
        "SELECT id FROM shifts WHERE branch_id=? AND status='open' ORDER BY opened_at DESC LIMIT 1",
      )
      .get(request.user.branchId) as
      { id: string } | undefined;
    inTransaction(db, () => {
      db.prepare(
        `INSERT INTO staff_ledger (id, user_id, branch_id, type, amount, note, effective_date, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        userId,
        request.user.branchId,
        String(body.type),
        amount,
        note,
        effectiveDate,
        request.user.sub,
        timestamp,
      );
      if (body.type === "advance" || body.type === "salary_payment") {
        db.prepare(
          `INSERT INTO treasury_movements (id, branch_id, shift_id, type, amount, payment_method, reference_type, reference_id, description, user_id, created_at)
        VALUES (?, ?, ?, ?, ?, 'cash', 'staff_ledger', ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          request.user.branchId,
          activeShift?.id ?? null,
          String(body.type),
          -amount,
          id,
          note,
          request.user.sub,
          timestamp,
        );
      }
      insertAudit(db, {
        branchId: request.user.branchId,
        userId: request.user.sub,
        action: "staff.ledger_entry_created",
        entityType: "staff_ledger",
        entityId: id,
        newValue: { employeeId: userId, ...body, amount, effectiveDate },
      });
      enqueueSync(
        db,
        request.user.branchId,
        "staff_ledger",
        id,
        "staff.ledger_entry_created",
        { id, employeeId: userId, ...body, amount, effectiveDate, timestamp },
      );
    });
    return reply.status(201).send({ id });
  },
);

app.get(
  "/api/treasury",
  { preHandler: requirePermission("treasury.manage") },
  async (request) => {
    const movements = db
      .prepare(
        `SELECT t.*, u.name AS user_name, u.name_ar AS user_name_ar FROM treasury_movements t JOIN users u ON u.id = t.user_id
    WHERE t.branch_id = ? ORDER BY t.created_at DESC LIMIT 150`,
      )
      .all(request.user.branchId);
    const totals = db
      .prepare(
        `SELECT payment_method, SUM(amount) AS amount FROM treasury_movements
    WHERE branch_id = ? GROUP BY payment_method`,
      )
      .all(request.user.branchId);
    const shift = db
      .prepare(
        `SELECT s.*, u.name AS user_name, u.name_ar AS user_name_ar FROM shifts s JOIN users u ON u.id = s.user_id
    WHERE s.branch_id = ? AND s.status = 'open' AND u.is_super_admin=0
      AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id=u.role_id AND rp.permission='shifts.manage')
    ORDER BY s.opened_at DESC LIMIT 1`,
      )
      .get(request.user.branchId);
    const shifts = db
      .prepare(
        `SELECT s.*, u.name AS user_name, u.name_ar AS user_name_ar,
    COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.total-o.refunded_amount ELSE 0 END),0) AS sales,
    COALESCE(SUM(CASE WHEN o.status = 'completed' AND o.payment_method = 'cash' THEN o.total-o.refunded_amount ELSE 0 END),0) AS cash_sales,
    COALESCE(SUM(CASE WHEN o.status = 'completed' AND o.payment_method = 'card' THEN o.total-o.refunded_amount ELSE 0 END),0) AS card_sales,
    COALESCE(SUM(CASE WHEN o.status = 'completed' AND o.payment_method = 'credit' THEN o.total-o.refunded_amount ELSE 0 END),0) AS credit_sales,
    COALESCE(SUM(CASE WHEN o.status = 'completed' AND o.refunded_amount=0 THEN o.discount_amount ELSE 0 END),0) AS discounts,
    COUNT(CASE WHEN o.status = 'completed' AND o.refunded_amount=0 THEN 1 END) AS transactions,
    COUNT(CASE WHEN o.status = 'voided' THEN 1 END) AS voids,
    COUNT(CASE WHEN o.refunded_amount>0 THEN 1 END) AS refunds,
    COALESCE(SUM(o.refunded_amount),0) AS refund_amount,
    COALESCE((SELECT SUM(-tm.amount) FROM treasury_movements tm WHERE tm.shift_id=s.id AND tm.type='expense'),0) AS expenses,
    COALESCE((SELECT SUM(CASE WHEN tm.amount>0 AND tm.type IN ('owner_deposit','other_income') THEN tm.amount ELSE 0 END) FROM treasury_movements tm WHERE tm.shift_id=s.id AND tm.payment_method='cash'),0) AS cash_added,
    COALESCE((SELECT SUM(CASE WHEN tm.amount<0 AND tm.type NOT IN ('void','refund') THEN -tm.amount ELSE 0 END) FROM treasury_movements tm WHERE tm.shift_id=s.id AND tm.payment_method='cash'),0) AS cash_removed
    FROM shifts s JOIN users u ON u.id = s.user_id
    LEFT JOIN orders o ON o.shift_id = s.id WHERE s.branch_id = ? AND u.is_super_admin=0
      AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id=u.role_id AND rp.permission='shifts.manage')
    GROUP BY s.id ORDER BY s.opened_at DESC LIMIT 30`,
      )
      .all(request.user.branchId);
    return { movements, totals, shift, shifts };
  },
);

app.post(
  "/api/treasury/movements",
  { preHandler: requirePermission("treasury.manage") },
  async (request, reply) => {
    const body = request.body as {
      direction?: "in" | "out";
      type?: string;
      category?: string;
      amount?: number;
      paymentMethod?: "cash" | "card";
      description?: string;
      attachment?: string;
    };
    const amount = Number(body.amount);
    const description = body.description?.trim();
    const allowedTypes = [
      "owner_deposit",
      "other_income",
      "supplier_payment",
      "withdrawal",
      "stock_purchase",
      "miscellaneous",
    ];
    if (
      !allowedTypes.includes(String(body.type)) ||
      !["in", "out"].includes(String(body.direction)) ||
      !Number.isInteger(amount) ||
      amount <= 0 ||
      !description ||
      !["cash", "card"].includes(String(body.paymentMethod))
    ) {
      return reply.status(400).send({
        error:
          "Direction, movement type, amount, payment method, and notes are required",
      });
    }
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const signedAmount = body.direction === "in" ? amount : -amount;
    const activeShift = db
      .prepare(
        "SELECT id FROM shifts WHERE branch_id=? AND status='open' ORDER BY opened_at DESC LIMIT 1",
      )
      .get(request.user.branchId) as
      { id: string } | undefined;
    db.prepare(
      `INSERT INTO treasury_movements (id, branch_id, shift_id, type, category, amount, payment_method, reference_type, reference_id, description, attachment, user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      request.user.branchId,
      activeShift?.id ?? null,
      String(body.type),
      body.category ?? "",
      signedAmount,
      String(body.paymentMethod),
      id,
      description,
      body.attachment ?? "",
      request.user.sub,
      timestamp,
    );
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "treasury.movement_created",
      entityType: "treasury_movement",
      entityId: id,
      newValue: { ...body, amount: signedAmount },
    });
    enqueueSync(
      db,
      request.user.branchId,
      "treasury_movement",
      id,
      "treasury.movement_created",
      { id, ...body, amount: signedAmount, timestamp },
    );
    return reply.status(201).send({ id });
  },
);

app.post(
  "/api/expenses",
  { preHandler: requirePermission("expenses.manage") },
  async (request, reply) => {
    const body = request.body as {
      category?: string;
      description?: string;
      amount?: number;
      paymentMethod?: "cash" | "card";
    };
    const amount = Number(body.amount);
    if (
      !body.category?.trim() ||
      !body.description?.trim() ||
      !Number.isInteger(amount) ||
      amount <= 0 ||
      !["cash", "card"].includes(String(body.paymentMethod))
    ) {
      return reply.status(400).send({
        error: "Category, description, amount, and payment method are required",
      });
    }
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const activeShift = db
      .prepare(
        "SELECT id FROM shifts WHERE branch_id=? AND status='open' ORDER BY opened_at DESC LIMIT 1",
      )
      .get(request.user.branchId) as
      { id: string } | undefined;
    inTransaction(db, () => {
      db.prepare(
        `INSERT INTO expenses (id, branch_id, category, description, amount, payment_method, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        request.user.branchId,
        body.category!.trim(),
        body.description!.trim(),
        amount,
        String(body.paymentMethod),
        request.user.sub,
        timestamp,
      );
      db.prepare(
        `INSERT INTO treasury_movements
      (id, branch_id, shift_id, type, amount, payment_method, reference_type, reference_id, description, user_id, created_at)
      VALUES (?, ?, ?, 'expense', ?, ?, 'expense', ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        request.user.branchId,
        activeShift?.id ?? null,
        -amount,
        String(body.paymentMethod),
        id,
        body.description!.trim(),
        request.user.sub,
        timestamp,
      );
      insertAudit(db, {
        branchId: request.user.branchId,
        userId: request.user.sub,
        action: "expense.created",
        entityType: "expense",
        entityId: id,
        newValue: body,
      });
      enqueueSync(db, request.user.branchId, "expense", id, "expense.created", {
        id,
        ...body,
        timestamp,
      });
    });
    return reply.status(201).send({ id });
  },
);

app.post(
  "/api/shifts/:id/close",
  { preHandler: requireAnyPermission("pos.shift", "shifts.manage") },
  async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as { closingCash?: number; note?: string };
    const closingCash = Number(body.closingCash);
    if (!Number.isInteger(closingCash) || closingCash < 0)
      return reply
        .status(400)
        .send({ error: "A valid closing cash count is required" });
    const shift = db
      .prepare(
        "SELECT * FROM shifts WHERE id = ? AND branch_id = ? AND status = 'open'",
      )
      .get(id, request.user.branchId) as Record<string, unknown> | undefined;
    if (!shift)
      return reply.status(404).send({ error: "Open shift not found" });
    const cashSales = (
      db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) AS amount FROM treasury_movements
    WHERE shift_id = ? AND payment_method = 'cash' AND type != 'opening_cash'`,
        )
        .get(id) as { amount: number }
    ).amount;
    const expected = Number(shift.opening_cash) + cashSales;
    const difference = closingCash - expected;
    const timestamp = new Date().toISOString();
    db.prepare(
      `UPDATE shifts SET status = 'closed', closed_at = ?, closing_cash = ?, expected_cash = ?, difference = ?, close_note = ? WHERE id = ?`,
    ).run(timestamp, closingCash, expected, difference, body.note ?? "", id);
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "shift.closed",
      entityType: "shift",
      entityId: id,
      originalValue: { status: "open" },
      newValue: { status: "closed", closingCash, expected, difference },
      reason: body.note ?? null,
    });
    enqueueSync(db, request.user.branchId, "shift", id, "shift.closed", {
      id,
      closingCash,
      expected,
      difference,
      timestamp,
    });
    const breakdown = db
      .prepare(
        `SELECT payment_method, COUNT(CASE WHEN refunded_amount=0 THEN 1 END) AS transactions, COALESCE(SUM(total-refunded_amount),0) AS sales,
    COALESCE(SUM(CASE WHEN refunded_amount=0 THEN discount_amount ELSE 0 END),0) AS discounts,COALESCE(SUM(refunded_amount),0) AS refunds FROM orders WHERE shift_id = ? AND status = 'completed' GROUP BY payment_method`,
      )
      .all(id);
    const voids = (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM orders WHERE shift_id = ? AND status = 'voided'",
        )
        .get(id) as { count: number }
    ).count;
    return { expected, difference, closedAt: timestamp, breakdown, voids };
  },
);

app.post(
  "/api/shifts/open",
  { preHandler: requirePermission("pos.shift") },
  async (request, reply) => {
    if (
      request.user.isSuperAdmin ||
      !request.user.permissions.includes("pos.access") ||
      request.user.permissions.includes("shifts.manage")
    )
      return reply.status(403).send({
        error: "Only POS staff can open an operational shift",
      });
    const body = request.body as { openingCash?: number };
    if (
      db
        .prepare(
          `SELECT s.id FROM shifts s JOIN users u ON u.id=s.user_id
           WHERE s.branch_id=? AND s.status='open' AND u.is_super_admin=0
             AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id=u.role_id AND rp.permission='shifts.manage')`,
        )
        .get(request.user.branchId)
    )
      return reply
        .status(409)
        .send({ error: "This branch already has an open shift" });
    const openingCash = Number(body.openingCash ?? 0);
    if (!Number.isInteger(openingCash) || openingCash < 0)
      return reply.status(400).send({ error: "Invalid opening cash" });
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    db.prepare(
      `INSERT INTO shifts (id, branch_id, user_id, opened_at, opening_cash, status)
    VALUES (?, ?, ?, ?, ?, 'open')`,
    ).run(
      id,
      request.user.branchId,
      request.user.sub,
      timestamp,
      openingCash,
    );
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "shift.opened",
      entityType: "shift",
      entityId: id,
      newValue: { openingCash },
    });
    enqueueSync(db, request.user.branchId, "shift", id, "shift.opened", {
      id,
      openingCash,
      timestamp,
    });
    return reply.status(201).send({ id, openedAt: timestamp });
  },
);

app.get(
  "/api/shifts/admin",
  { preHandler: requirePermission("shifts.manage") },
  async (request) => {
    const query = request.query as {
      from?: string;
      to?: string;
      userId?: string;
      branchId?: string;
      status?: string;
    };
    const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to ?? "")
      ? query.to!
      : currentBusinessDate();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from ?? "")
      ? query.from!
      : new Date(`${to}T12:00:00Z`,).toISOString().slice(0, 8) + "01";
    const availableBranches = request.user.isSuperAdmin
      ? (db.prepare("SELECT id,name,name_ar FROM branches WHERE active=1 ORDER BY name").all() as unknown as Array<{ id: string; name: string; name_ar: string }>)
      : (db.prepare("SELECT id,name,name_ar FROM branches WHERE id=?").all(request.user.branchId) as unknown as Array<{ id: string; name: string; name_ar: string }>);
    const branchIds = query.branchId && availableBranches.some((branch) => branch.id === query.branchId)
      ? [query.branchId]
      : availableBranches.map((branch) => branch.id);
    const placeholders = branchIds.map(() => "?").join(",");
    const conditions = [
      `s.branch_id IN (${placeholders})`,
      "substr(s.opened_at,1,10) BETWEEN ? AND ?",
      "u.is_super_admin=0",
      "NOT EXISTS (SELECT 1 FROM role_permissions shift_manager WHERE shift_manager.role_id=u.role_id AND shift_manager.permission='shifts.manage')",
    ];
    const params: Array<string> = [...branchIds, from, to];
    if (query.userId) {
      conditions.push("s.user_id=?");
      params.push(query.userId);
    }
    if (query.status === "open" || query.status === "closed") {
      conditions.push("s.status=?");
      params.push(query.status);
    }
    const shifts = db.prepare(`
      SELECT s.id,s.branch_id,b.name AS branch_name,b.name_ar AS branch_name_ar,
        s.user_id,u.name AS user_name,u.name_ar AS user_name_ar,s.opened_at,s.closed_at,
        s.opening_cash,s.closing_cash,s.expected_cash,s.difference,s.close_note,s.status,
        ROUND((julianday(COALESCE(s.closed_at,CURRENT_TIMESTAMP))-julianday(s.opened_at))*1440) AS duration_minutes,
        COUNT(o.id) AS orders,
        COALESCE(SUM(CASE WHEN o.status='completed' THEN o.total-o.refunded_amount ELSE 0 END),0) AS net_sales,
        COALESCE(SUM(CASE WHEN o.status='completed' AND o.payment_method='cash' THEN o.total-o.refunded_amount ELSE 0 END),0) AS cash_sales,
        COALESCE(SUM(CASE WHEN o.status='completed' AND o.payment_method='card' THEN o.total-o.refunded_amount ELSE 0 END),0) AS card_sales,
        COALESCE(SUM(CASE WHEN o.status='completed' AND o.payment_method='credit' THEN o.total-o.refunded_amount ELSE 0 END),0) AS credit_sales,
        COALESCE(SUM(CASE WHEN o.status='completed' THEN o.discount_amount ELSE 0 END),0) AS discounts,
        COALESCE(SUM(o.refunded_amount),0) AS refunds,
        (SELECT COALESCE(SUM(tm.amount),0) FROM treasury_movements tm WHERE tm.shift_id=s.id AND tm.payment_method='cash' AND tm.type!='opening_cash') AS cash_movements
      FROM shifts s JOIN users u ON u.id=s.user_id JOIN branches b ON b.id=s.branch_id
      LEFT JOIN orders o ON o.shift_id=s.id
      WHERE ${conditions.join(" AND ")}
      GROUP BY s.id ORDER BY s.opened_at DESC`).all(...params) as unknown as Array<Record<string, unknown>>;

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const nowMs = Date.now();
    const recentShifts = db.prepare(`
      SELECT s.*,u.name AS user_name,u.name_ar AS user_name_ar,b.name AS branch_name,b.name_ar AS branch_name_ar
      FROM shifts s JOIN users u ON u.id=s.user_id JOIN branches b ON b.id=s.branch_id
      WHERE s.branch_id IN (${placeholders}) AND julianday(COALESCE(s.closed_at,CURRENT_TIMESTAMP))>=julianday('now','-24 hours')
        AND julianday(s.opened_at)<=julianday('now') AND u.is_super_admin=0
        AND NOT EXISTS (SELECT 1 FROM role_permissions shift_manager WHERE shift_manager.role_id=u.role_id AND shift_manager.permission='shifts.manage')`).all(...branchIds) as unknown as Array<Record<string, unknown>>;
    const recentOrders = db.prepare(`
      SELECT o.user_id,o.status,o.payment_method,o.total,o.refunded_amount,o.discount_amount
      FROM orders o WHERE o.branch_id IN (${placeholders}) AND julianday(o.created_at)>=julianday('now','-24 hours')`).all(...branchIds) as unknown as Array<Record<string, unknown>>;
    const rollupMap = new Map<string, Record<string, number | string>>();
    for (const shift of recentShifts) {
      const userId = String(shift.user_id);
      const entry = rollupMap.get(userId) ?? {
        user_id: userId,
        user_name: String(shift.user_name),
        user_name_ar: String(shift.user_name_ar),
        shifts: 0,
        minutes: 0,
        opening_cash: 0,
        closing_cash: 0,
        variance: 0,
        orders: 0,
        net_sales: 0,
        cash_sales: 0,
        card_sales: 0,
        credit_sales: 0,
      };
      entry.shifts = Number(entry.shifts) + 1;
      const start = Math.max(new Date(String(shift.opened_at)).getTime(), cutoff);
      const end = Math.min(shift.closed_at ? new Date(String(shift.closed_at)).getTime() : nowMs, nowMs);
      entry.minutes = Number(entry.minutes) + Math.max(0, Math.round((end - start) / 60000));
      entry.opening_cash = Number(entry.opening_cash) + Number(shift.opening_cash ?? 0);
      entry.closing_cash = Number(entry.closing_cash) + Number(shift.closing_cash ?? 0);
      entry.variance = Number(entry.variance) + Number(shift.difference ?? 0);
      rollupMap.set(userId, entry);
    }
    for (const order of recentOrders) {
      const entry = rollupMap.get(String(order.user_id));
      if (!entry || order.status !== "completed") continue;
      const net = Number(order.total) - Number(order.refunded_amount ?? 0);
      entry.orders = Number(entry.orders) + 1;
      entry.net_sales = Number(entry.net_sales) + net;
      const key = `${String(order.payment_method)}_sales`;
      if (key in entry) entry[key] = Number(entry[key]) + net;
    }
    const summary = shifts.reduce<{
      shifts: number; open: number; minutes: number; orders: number;
      netSales: number; cashSales: number; variance: number;
    }>((total, shift) => ({
      shifts: total.shifts + 1,
      open: total.open + Number(shift.status === "open"),
      minutes: total.minutes + Number(shift.duration_minutes ?? 0),
      orders: total.orders + Number(shift.orders ?? 0),
      netSales: total.netSales + Number(shift.net_sales ?? 0),
      cashSales: total.cashSales + Number(shift.cash_sales ?? 0),
      variance: total.variance + Number(shift.difference ?? 0),
    }), { shifts: 0, open: 0, minutes: 0, orders: 0, netSales: 0, cashSales: 0, variance: 0 });
    const users = db.prepare(`SELECT DISTINCT u.id,u.name,u.name_ar FROM users u JOIN shifts s ON s.user_id=u.id WHERE s.branch_id IN (${placeholders}) AND u.is_super_admin=0 AND NOT EXISTS (SELECT 1 FROM role_permissions shift_manager WHERE shift_manager.role_id=u.role_id AND shift_manager.permission='shifts.manage') ORDER BY u.name`).all(...branchIds);
    return { from, to, summary, shifts, rolling24: [...rollupMap.values()], filters: { branches: availableBranches, users } };
  },
);

app.get(
  "/api/reports/summary",
  { preHandler: requirePermission("reports.financial") },
  async (request) => {
    const query = request.query as {
      from?: string;
      to?: string;
      branches?: string;
      employeeId?: string;
      paymentMethod?: string;
      productId?: string;
      categoryId?: string;
      customerId?: string;
    };
    const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to ?? "")
      ? query.to!
      : currentBusinessDate();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from ?? "")
      ? query.from!
      : new Date(`${to}T12:00:00Z`).toISOString().slice(0, 8) + "01";
    const requested = (query.branches ?? "").split(",").filter(Boolean);
    const branchIds =
      request.user.isSuperAdmin && requested.length
        ? requested
        : [request.user.branchId];
    const placeholders = branchIds.map(() => "?").join(",");
    const conditions = [
      `o.branch_id IN (${placeholders})`,
      "o.business_date BETWEEN ? AND ?",
    ];
    const params: Array<string | number> = [...branchIds, from, to];
    if (query.employeeId) {
      conditions.push("o.user_id = ?");
      params.push(query.employeeId);
    }
    if (query.paymentMethod) {
      conditions.push("o.payment_method = ?");
      params.push(query.paymentMethod);
    }
    if (query.customerId) {
      conditions.push("o.customer_id = ?");
      params.push(query.customerId);
    }
    if (query.productId) {
      conditions.push(
        "EXISTS (SELECT 1 FROM order_items filter_item WHERE filter_item.order_id = o.id AND filter_item.product_id = ?)",
      );
      params.push(query.productId);
    }
    if (query.categoryId) {
      conditions.push(
        "EXISTS (SELECT 1 FROM order_items filter_item JOIN products filter_product ON filter_product.id=filter_item.product_id WHERE filter_item.order_id=o.id AND filter_product.category_id = ?)",
      );
      params.push(query.categoryId);
    }
    const where = conditions.join(" AND ");
    const summary = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status='completed' THEN total-refunded_amount ELSE 0 END),0) AS revenue, COUNT(CASE WHEN status='completed' AND refunded_amount=0 THEN 1 END) AS orders, COALESCE(SUM(CASE WHEN status='completed' AND refunded_amount=0 THEN discount_amount ELSE 0 END),0) AS discounts,
    COALESCE(AVG(CASE WHEN status='completed' AND refunded_amount=0 THEN total END),0) AS average_order, COUNT(CASE WHEN status='voided' THEN 1 END) AS voids,COUNT(CASE WHEN refunded_amount>0 THEN 1 END) AS refunds,COALESCE(SUM(refunded_amount),0) AS refund_amount FROM orders o WHERE ${where}`,
      )
      .get(...params);
    const completedWhere = `${where} AND o.status='completed' AND o.refunded_amount=0`;
    const daily = db
      .prepare(
        `SELECT o.business_date AS date,SUM(o.total) AS revenue,COUNT(*) AS orders FROM orders o WHERE ${completedWhere} GROUP BY date ORDER BY date`,
      )
      .all(...params);
    const payments = db
      .prepare(
        `SELECT o.payment_method,SUM(o.total) AS revenue,COUNT(*) AS orders FROM orders o WHERE ${completedWhere} GROUP BY o.payment_method`,
      )
      .all(...params);
    const products = db
      .prepare(
        `SELECT oi.product_name AS name,oi.product_name_ar AS name_ar,SUM(oi.quantity) AS quantity,SUM(oi.total) AS revenue,SUM((oi.unit_price-oi.unit_cost)*oi.quantity) AS gross_profit FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id WHERE ${completedWhere} GROUP BY oi.product_id ORDER BY revenue DESC LIMIT 30`,
      )
      .all(...params);
    const staff = db
      .prepare(
        `SELECT u.name,COUNT(o.id) AS orders,COALESCE(SUM(o.total),0) AS revenue FROM orders o JOIN users u ON u.id=o.user_id WHERE ${completedWhere} GROUP BY u.id ORDER BY revenue DESC`,
      )
      .all(...params);
    const categorySales = db
      .prepare(
        `SELECT c.name,c.name_ar,SUM(oi.total) AS revenue,SUM(oi.quantity) AS quantity FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN products p ON p.id=oi.product_id JOIN categories c ON c.id=p.category_id WHERE ${completedWhere} GROUP BY c.id ORDER BY revenue DESC`,
      )
      .all(...params);
    const branchBounds = [...branchIds, from, to];
    const branchWhere = `branch_id IN (${placeholders}) AND substr(created_at,1,10) BETWEEN ? AND ?`;
    const expenses = (
      db
        .prepare(
          `SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE ${branchWhere}`,
        )
        .get(...branchBounds) as { total: number }
    ).total;
    const ingredientConditions = [
      `m.branch_id IN (${placeholders})`,
      "substr(m.created_at,1,10) BETWEEN ? AND ?",
    ];
    const ingredientParams: Array<string | number> = [...branchBounds];
    if (query.employeeId) {
      ingredientConditions.push("m.user_id = ?");
      ingredientParams.push(query.employeeId);
    }
    if (query.paymentMethod) {
      ingredientConditions.push(
        "(m.reference_type!='order' OR EXISTS (SELECT 1 FROM orders io WHERE io.id=m.reference_id AND io.payment_method=?))",
      );
      ingredientParams.push(query.paymentMethod);
    }
    if (query.customerId) {
      ingredientConditions.push(
        "(m.reference_type!='order' OR EXISTS (SELECT 1 FROM orders io WHERE io.id=m.reference_id AND io.customer_id=?))",
      );
      ingredientParams.push(query.customerId);
    }
    if (query.productId) {
      ingredientConditions.push(
        "(m.reference_type!='order' OR EXISTS (SELECT 1 FROM order_items ioi WHERE ioi.order_id=m.reference_id AND ioi.product_id=?))",
      );
      ingredientParams.push(query.productId);
    }
    if (query.categoryId) {
      ingredientConditions.push(
        "(m.reference_type!='order' OR EXISTS (SELECT 1 FROM order_items ioi JOIN products ip ON ip.id=ioi.product_id WHERE ioi.order_id=m.reference_id AND ip.category_id=?))",
      );
      ingredientParams.push(query.categoryId);
    }
    const ingredients = db
      .prepare(
        `SELECT i.name,i.name_ar,i.unit,SUM(CASE WHEN m.type='estimated_sale_usage' THEN -m.quantity ELSE 0 END) AS consumed,SUM(CASE WHEN m.type IN ('wastage','damaged','adjustment') AND m.quantity<0 THEN -m.quantity ELSE 0 END) AS actual_out FROM inventory_item_movements m JOIN inventory_items i ON i.id=m.inventory_item_id WHERE ${ingredientConditions.join(" AND ")} GROUP BY i.id ORDER BY consumed DESC`,
      )
      .all(...ingredientParams);
    const treasury = db
      .prepare(
        `SELECT type,COALESCE(SUM(amount),0) AS amount,COUNT(*) AS movements FROM treasury_movements WHERE ${branchWhere} GROUP BY type ORDER BY ABS(amount) DESC`,
      )
      .all(...branchBounds);
    const inventoryMovements = db
      .prepare(
        `SELECT type,COUNT(*) AS movements,COALESCE(SUM(quantity),0) AS quantity FROM inventory_movements WHERE ${branchWhere} GROUP BY type`,
      )
      .all(...branchBounds);
    const customerPayments = db
      .prepare(
        `SELECT COALESCE(SUM(amount),0) AS amount,COUNT(*) AS payments FROM treasury_movements WHERE ${branchWhere} AND type='credit_payment'`,
      )
      .get(...branchBounds) as object;
    const customerOutstanding = db
      .prepare(
        "SELECT COALESCE(SUM(credit_balance),0) AS amount,COUNT(CASE WHEN credit_balance>0 THEN 1 END) AS customers FROM customers WHERE active=1",
      )
      .get() as object;
    const shiftDifferences = db
      .prepare(
        `SELECT s.id,u.name,s.opened_at,s.closed_at,s.expected_cash,s.closing_cash,s.difference FROM shifts s JOIN users u ON u.id=s.user_id WHERE s.branch_id IN (${placeholders}) AND s.status='closed' AND u.is_super_admin=0 AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id=u.role_id AND rp.permission='shifts.manage') AND substr(s.closed_at,1,10) BETWEEN ? AND ? ORDER BY s.closed_at DESC LIMIT 50`,
      )
      .all(...branchBounds);
    const branchComparison = db
      .prepare(
        `SELECT b.id,b.name,b.name_ar,COUNT(CASE WHEN o.refunded_amount=0 THEN o.id END) AS orders,COALESCE(SUM(o.total-o.refunded_amount),0) AS revenue FROM branches b LEFT JOIN orders o ON o.branch_id=b.id AND o.status='completed' AND o.business_date BETWEEN ? AND ? WHERE b.id IN (${placeholders}) GROUP BY b.id ORDER BY revenue DESC`,
      )
      .all(from, to, ...branchIds);
    const employeeAudit = db
      .prepare(
        `SELECT u.name,COUNT(a.id) AS events FROM audit_logs a JOIN users u ON u.id=a.user_id WHERE a.branch_id IN (${placeholders}) AND substr(a.created_at,1,10) BETWEEN ? AND ? GROUP BY u.id ORDER BY events DESC`,
      )
      .all(...branchBounds);
    const filters = {
      branches: db
        .prepare(
          "SELECT id,name,name_ar FROM branches WHERE active=1 ORDER BY name",
        )
        .all(),
      employees: db
        .prepare(
          `SELECT id,name,name_ar FROM users WHERE active=1 AND branch_id IN (${placeholders}) ORDER BY name`,
        )
        .all(...branchIds),
      products: db
        .prepare(
          "SELECT id,name,name_ar FROM products WHERE active=1 ORDER BY name",
        )
        .all(),
      categories: db
        .prepare(
          "SELECT id,name,name_ar FROM categories WHERE active=1 ORDER BY name",
        )
        .all(),
      customers: db
        .prepare("SELECT id,name FROM customers WHERE active=1 ORDER BY name")
        .all(),
    };
    return {
      from,
      to,
      summary,
      daily,
      payments,
      products,
      staff,
      expenses,
      ingredients,
      categorySales,
      treasury,
      inventoryMovements,
      customerPayments,
      customerOutstanding,
      shiftDifferences,
      branchComparison,
      employeeAudit,
      filters,
    };
  },
);

app.get(
  "/api/settings",
  { preHandler: requirePermission("settings.manage") },
  async () => {
    const rows = db
      .prepare("SELECT key, value, updated_at FROM settings ORDER BY key")
      .all() as unknown as Array<{
      key: string;
      value: string;
      updated_at: string;
    }>;
    return {
      settings: Object.fromEntries(
        rows.map((row) => [row.key, JSON.parse(row.value)]),
      ),
    };
  },
);

app.put(
  "/api/settings/:key",
  { preHandler: requirePermission("settings.manage") },
  async (request, reply) => {
    const key = (request.params as { key: string }).key;
    if (!["tax", "brand", "receipt"].includes(key))
      return reply.status(400).send({ error: "Unsupported setting" });
    const value = request.body as Record<string, unknown>;
    if (key === "tax") {
      const rate = Number(value.rate ?? 0);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100)
        return reply
          .status(400)
          .send({ error: "Tax rate must be between 0 and 100" });
    }
    const previous = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    const timestamp = new Date().toISOString();
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(value), timestamp);
    insertAudit(db, {
      branchId: request.user.branchId,
      userId: request.user.sub,
      action: "settings.updated",
      entityType: "setting",
      entityId: key,
      originalValue: previous ? JSON.parse(previous.value) : null,
      newValue: value,
    });
    enqueueSync(db, request.user.branchId, "setting", key, "settings.updated", {
      key,
      value,
      timestamp,
    });
    return { key, value, updatedAt: timestamp };
  },
);

app.get("/api/sync/status", { preHandler: authenticate }, async (request) => {
  if (cloudServer)
    return {
      mode: "cloud" as const,
      state: "synced" as const,
      pending: 0,
      failed: 0,
      cloudConfigured: true,
      paired: true,
      branchId: request.user.branchId,
    };
  const pending = (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM sync_outbox WHERE branch_id = ? AND synced_at IS NULL",
      )
      .get(request.user.branchId) as { count: number }
  ).count;
  const failed = (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM sync_outbox WHERE branch_id = ? AND synced_at IS NULL AND attempts > 0",
      )
      .get(request.user.branchId) as { count: number }
  ).count;
  return {
    mode: "branch" as const,
    state: (process.env.CLOUD_SYNC_URL || getRuntimeValue(db, "cloud_url"))
      ? failed
        ? "error"
        : pending
          ? "pending"
          : "synced"
      : "offline",
    pending,
    failed,
    cloudConfigured: Boolean(
      process.env.CLOUD_SYNC_URL || getRuntimeValue(db, "cloud_url"),
    ),
    paired: pairedWithCloud(),
    branchId: request.user.branchId,
  };
});

const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/"))
      return reply.status(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

const port = Number(process.env.PORT ?? 4100);
await app.listen({ port, host: "0.0.0.0" });
const stopSyncWorker = startSyncWorker(db, app.log);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Gracefully stopping Talk & TASTE");
  stopSyncWorker();
  await app.close();
  db.close();
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

export { app, db };
