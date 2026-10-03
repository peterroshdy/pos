import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchCashDrawer } from "./hardware.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

describe("cash drawer hardware bridge", () => {
  it("fails clearly when no bridge is configured", async () => {
    await expect(
      dispatchCashDrawer({ branchId: "BR-TEST" }),
    ).resolves.toEqual({
      dispatched: false,
      hardwareError: "Cash drawer hardware bridge is not configured",
    });
  });

  it("sends an authenticated drawer command without printable content", async () => {
    let receivedAuthorization = "";
    let receivedBody = "";
    const server = createServer((request, response) => {
      receivedAuthorization = String(request.headers.authorization ?? "");
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        receivedBody += chunk;
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Test bridge did not bind to a TCP port");

    const result = await dispatchCashDrawer({
      branchId: "BR-CITY-STARS",
      commandUrl: `http://127.0.0.1:${address.port}/command`,
      commandToken: "hardware-test-token",
    });

    expect(result).toEqual({ dispatched: true, hardwareError: null });
    expect(receivedAuthorization).toBe("Bearer hardware-test-token");
    expect(JSON.parse(receivedBody)).toEqual({
      command: "open-drawer",
      branchId: "BR-CITY-STARS",
    });
    expect(receivedBody).not.toContain("print");
  });

  it("reports a rejected hardware command as a failure", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Test bridge did not bind to a TCP port");

    const result = await dispatchCashDrawer({
      branchId: "BR-TEST",
      commandUrl: `http://127.0.0.1:${address.port}/command`,
    });

    expect(result.dispatched).toBe(false);
    expect(result.hardwareError).toBe("Hardware bridge returned 503");
  });
});
