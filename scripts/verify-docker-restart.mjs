import { execFileSync } from "node:child_process";

const project = "talk-and-taste-restart-verification";
const container = "talk-and-taste-branch";
const port = 18080;
const base = `http://127.0.0.1:${port}/api`;
const ownerPassword = "RestartOwnerOnly#2026";
const baristaPassword = "RestartBaristaOnly#2026";

const check = (value, message) => {
  if (!value) throw new Error(message);
};
const docker = (...args) =>
  execFileSync("docker", args, {
    cwd: process.cwd(),
    env: { ...process.env, APP_PORT: String(port) },
    stdio: "inherit",
  });
const request = async (method, path, token, body) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(`${path} returned ${response.status}: ${JSON.stringify(data)}`);
  return data;
};
const waitForHealth = async () => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const health = await request("GET", "/health");
      if (health.status === "ok" && health.database === "connected") return health;
    } catch {
      // Docker can accept the restart command before the HTTP listener is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Local Docker POS did not become healthy");
};

let started = false;
try {
  try {
    execFileSync("docker", ["inspect", container], { stdio: "ignore" });
    throw new Error(
      `${container} already exists. Stop the real branch POS before running this isolated verification.`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists")) throw error;
  }

  docker("compose", "-p", project, "-f", "compose.yml", "up", "-d", "--build");
  started = true;
  const firstHealth = await waitForHealth();
  await request("POST", "/setup/owner", "", {
    password: ownerPassword,
    confirmPassword: ownerPassword,
    baristaPassword,
  });
  const login = await request("POST", "/auth/login", "", {
    username: "Barista",
    password: baristaPassword,
  });
  const opened = await request("POST", "/shifts/open", login.token, {
    openingCash: 13700,
  });
  const before = await request("GET", "/pos/context", login.token);
  check(before.shift?.id === opened.id, "The shift was not open before restart");

  docker("restart", "--timeout", "30", container);
  const restartedHealth = await waitForHealth();
  const session = await request("GET", "/session", login.token);
  const after = await request("GET", "/pos/context", login.token);
  check(session.username === "Barista", "The Barista session did not survive restart");
  check(after.shift?.id === opened.id, "The same open shift was not recovered");
  check(after.shift.opening_cash === 13700, "The opening cash changed after restart");

  console.log(
    JSON.stringify({
      status: "passed",
      databaseConnected: true,
      sessionSurvivedRestart: true,
      openShiftSurvivedRestart: true,
      branchIdentityPreserved:
        firstHealth.branchId === restartedHealth.branchId,
      shiftId: opened.id,
    }),
  );
} finally {
  if (started)
    docker(
      "compose",
      "-p",
      project,
      "-f",
      "compose.yml",
      "down",
      "-v",
      "--remove-orphans",
    );
}
