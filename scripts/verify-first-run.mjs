import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const check = (value, message) => {
  if (!value) throw new Error(message);
};
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const directory = await mkdtemp(join(tmpdir(), "talk-and-taste-first-run-"));
const cloudDatabase = join(directory, "cloud.db");
const localDatabase = join(directory, "branch.db");
const children = new Set();

const start = async (databasePath, overrides) => {
  const port = await freePort();
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DATABASE_PATH: databasePath,
    ...overrides,
  };
  for (const key of [
    "JWT_SECRET",
    "BOOTSTRAP_ADMIN_PASSWORD",
    "BOOTSTRAP_ADMIN_PIN",
    "BRANCH_ID",
    "CLOUD_SYNC_URL",
    "CLOUD_SYNC_TOKEN",
    "CLOUD_DEVICE_TOKEN",
    "CLOUD_BRANCH_TOKENS",
    "CLOUD_DEVICE_TOKENS",
  ]) {
    if (!(key in overrides)) delete env[key];
  }
  let logs = "";
  const child = spawn(process.execPath, ["apps/api/dist/server.js"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout.on("data", (chunk) => (logs += chunk.toString()));
  child.stderr.on("data", (chunk) => (logs += chunk.toString()));
  const base = `http://127.0.0.1:${port}/api`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) return { base, child, logs: () => logs };
    } catch {
      // The process is still starting.
    }
    await wait(100);
  }
  throw new Error(`Server did not become ready. Logs:\n${logs}`);
};

const stop = async (server) => {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill("SIGTERM");
  await new Promise((resolve) => server.child.once("exit", resolve));
  children.delete(server.child);
};

const request = async (base, method, path, token, body) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
};

const password = "FirstLaunchOnly#2026";
const cloudPassword = "CloudVerificationOnly#2026";
let cloud;
let local;

try {
  cloud = await start(cloudDatabase, {
    CLOUD_RECEIVER_ENABLED: "true",
    BOOTSTRAP_ADMIN_PASSWORD: cloudPassword,
  });

  local = await start(localDatabase, {
    CLOUD_RECEIVER_ENABLED: "false",
    CLOUD_ENROLLMENT_URL: cloud.base.replace(/\/api$/, ""),
  });
  const initialHealth = await fetch(`${local.base}/health`).then((r) => r.json());
  const initial = await fetch(`${local.base}/setup/status`).then((r) => r.json());
  check(initial.requiresOwnerSetup, "Fresh installation skipped owner setup");
  check(initial.requiresPairing, "Fresh installation was unexpectedly paired");
  check(/^LOCAL-[A-F0-9]{8}$/.test(initialHealth.branchId), "Temporary local identity was not generated");

  const ownerSetup = await request(local.base, "POST", "/setup/owner", "", {
    password,
    confirmPassword: password,
    baristaPassword: "FirstBaristaOnly#2026",
  });
  check(ownerSetup.response.status === 201, "Offline owner setup failed");
  const loginOptions = await request(local.base, "GET", "/auth/login-options");
  check(
    loginOptions.data.mode === "branch" &&
      loginOptions.data.users.length === 2 &&
      loginOptions.data.users.some((user) => user.name === "admin") &&
      loginOptions.data.users.some((user) => user.name === "Barista"),
    "Local login did not expose exactly admin and Barista",
  );
  const localLogin = await request(local.base, "POST", "/auth/login", "", {
    username: "admin",
    password,
  });
  check(localLogin.response.ok && localLogin.data.token, "Offline owner could not sign in");
  const localToken = localLogin.data.token;
  const baristaLogin = await request(local.base, "POST", "/auth/login", "", {
    username: "Barista",
    password: "FirstBaristaOnly#2026",
  });
  check(baristaLogin.response.ok && baristaLogin.data.token, "Offline Barista could not sign in");
  const baristaCatalog = await request(local.base, "GET", "/catalog", baristaLogin.data.token);
  const blockedBaristaSettings = await request(local.base, "GET", "/settings", baristaLogin.data.token);
  const blockedAdminPos = await request(local.base, "GET", "/catalog", localToken);
  check(baristaCatalog.response.ok, "Barista POS permission was not granted");
  check(blockedBaristaSettings.response.status === 403, "Barista reached Admin settings");
  check(blockedAdminPos.response.status === 403, "Admin retained POS access");

  const changed = await request(local.base, "PUT", "/settings/tax", localToken, {
    enabled: false,
    rate: 0,
    pricesIncludeTax: true,
  });
  check(changed.response.ok, "Offline operation could not be recorded");
  const beforePair = await request(local.base, "GET", "/sync/status", localToken);
  check(!beforePair.data.paired, "Offline installation reported itself paired");
  check(beforePair.data.pending >= 3, "Offline history was not queued durably");

  const cloudLogin = await request(cloud.base, "POST", "/auth/login", "", {
    username: "admin",
    password: cloudPassword,
  });
  check(cloudLogin.response.ok && cloudLogin.data.token, "Cloud owner login failed");
  const cloudToken = cloudLogin.data.token;
  const created = await request(cloud.base, "POST", "/branches", cloudToken, {
    code: "VERIFY",
    name: "Verification Branch",
    nameAr: "فرع التحقق",
  });
  check(created.response.status === 201, "Cloud branch creation failed");
  const cloudBranchId = created.data.id;
  const pairing = await request(
    cloud.base,
    "POST",
    `/branches/${cloudBranchId}/pairing-code`,
    cloudToken,
  );
  check(pairing.response.ok && pairing.data.code, "Cloud pairing code creation failed");

  const paired = await request(local.base, "POST", "/setup/pair", localToken, {
    pairingCode: pairing.data.code,
  });
  check(paired.response.ok, `Late pairing failed: ${JSON.stringify(paired.data)}`);
  check(paired.data.branchId === cloudBranchId, "Installation adopted the wrong cloud branch");
  const sessionAfterPair = await request(local.base, "GET", "/session", localToken);
  check(sessionAfterPair.response.ok, "Existing owner session failed after pairing");
  check(sessionAfterPair.data.branchId === cloudBranchId, "Owner history was not reassigned to the cloud branch");

  const reused = await request(cloud.base, "POST", "/enroll", "", {
    pairingCode: pairing.data.code,
  });
  check(reused.response.status === 409, "One-time pairing code could be reused");

  await stop(local);
  local = await start(localDatabase, {
    CLOUD_RECEIVER_ENABLED: "false",
    CLOUD_ENROLLMENT_URL: cloud.base.replace(/\/api$/, ""),
  });
  const restartedHealth = await fetch(`${local.base}/health`).then((r) => r.json());
  check(restartedHealth.branchId === cloudBranchId, "Paired branch identity changed after restart");
  const persistentSession = await request(local.base, "GET", "/session", localToken);
  check(persistentSession.response.ok, "Generated JWT secret did not persist across restart");

  let uploaded = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const overview = await request(cloud.base, "GET", "/cloud/overview", cloudToken);
    const uploadedEvents = overview.data.recent?.filter(
      (event) => event.branch_id === cloudBranchId,
    ).length;
    if (uploadedEvents >= beforePair.data.pending) {
      uploaded = true;
      break;
    }
    await wait(250);
  }
  check(uploaded, "Queued offline history was not uploaded after pairing");

  console.log(
    JSON.stringify({
      status: "passed",
      offlineFirstRun: true,
      usernameAuthentication: true,
      twoUserRoster: true,
      permissionSeparatedInterfaces: true,
      lateCloudPairing: true,
      queuedHistoryUploaded: true,
      oneTimePairingCode: true,
      persistentGeneratedJwtSecret: true,
      branchId: cloudBranchId,
    }),
  );
} finally {
  await stop(local);
  await stop(cloud);
  for (const child of children) child.kill("SIGTERM");
  await rm(directory, { recursive: true, force: true });
}
