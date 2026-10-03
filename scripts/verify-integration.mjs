import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const check = (value, message) => {
  if (!value) throw new Error(message);
};
const tempDirectory = await mkdtemp(join(tmpdir(), "token-taste-verify-"));
const password = "IntegrationOnly#2026";
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const value = typeof address === "object" && address ? address.port : 0;
    server.close((error) => (error ? reject(error) : resolve(value)));
  });
});
const child = spawn(process.execPath, ["apps/api/dist/server.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DATABASE_PATH: join(tempDirectory, "verify.db"),
    JWT_SECRET: "integration-verification-secret-at-least-32-characters",
    BOOTSTRAP_ADMIN_PASSWORD: password,
    BUSINESS_TIMEZONE: "Africa/Cairo",
    BRANCH_ID: "BR-VERIFY-01",
    CLOUD_RECEIVER_ENABLED: "true",
    CLOUD_BRANCH_TOKENS: JSON.stringify({
      "BR-VERIFY-01": "verify-branch-token-unique",
    }),
    CLOUD_DEVICE_TOKENS: JSON.stringify({
      "BR-VERIFY-01": "verify-device-token-unique",
    }),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (chunk) => {
  logs += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  logs += chunk.toString();
});

const base = `http://127.0.0.1:${port}/api`;
const request = async (method, path, token, body) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok)
    throw new Error(
      `${path} returned ${response.status}: ${JSON.stringify(data)}`,
    );
  return data;
};
const get = (path, token) => request("GET", path, token);
const post = (path, token, body) => request("POST", path, token, body);

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await get("/health")).status === "ok") break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (attempt === 79)
      throw new Error(`Server did not become healthy. Logs:\n${logs}`);
  }
  const syncEvent = {
    eventId: crypto.randomUUID(),
    branchId: "BR-VERIFY-01",
    sequence: 9001,
    aggregateType: "order",
    aggregateId: crypto.randomUUID(),
    eventType: "order.completed",
    occurredAt: new Date().toISOString(),
    payload: { total: 12345 },
  };
  const missingDevice = await fetch(`${base}/sync/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer verify-branch-token-unique",
      "x-branch-id": "BR-VERIFY-01",
    },
    body: JSON.stringify(syncEvent),
  });
  check(
    missingDevice.status === 401,
    "Cloud receiver accepted an event without its configured device credential",
  );
  const sendCloudEvent = () =>
    fetch(`${base}/sync/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer verify-branch-token-unique",
        "x-branch-id": "BR-VERIFY-01",
        "x-device-token": "verify-device-token-unique",
      },
      body: JSON.stringify(syncEvent),
    }).then(async (response) => ({
      status: response.status,
      data: await response.json(),
    }));
  const received = await sendCloudEvent();
  const duplicate = await sendCloudEvent();
  check(
    received.status === 202 &&
      !received.data.duplicate &&
      duplicate.status === 200 &&
      duplicate.data.duplicate,
    "Cloud receiver idempotency failed",
  );
  const transferSyncEvent = {
    eventId: crypto.randomUUID(),
    branchId: "BR-VERIFY-01",
    sequence: 9002,
    aggregateType: "inventory_transfer",
    aggregateId: crypto.randomUUID(),
    eventType: "inventory.transfer_dispatched",
    occurredAt: new Date().toISOString(),
    payload: {
      id: crypto.randomUUID(),
      sourceBranchId: "BR-VERIFY-01",
      destinationBranchId: "BR-VERIFY-01",
      itemType: "product",
      itemId: "product-transfer-verification",
      sku: "COF-001",
      name: "Turkish Coffee",
      quantity: 2,
      unit: "pieces",
      reason: "Cloud inbox verification",
    },
  };
  const transferReceived = await fetch(`${base}/sync/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer verify-branch-token-unique",
      "x-branch-id": "BR-VERIFY-01",
      "x-device-token": "verify-device-token-unique",
    },
    body: JSON.stringify(transferSyncEvent),
  });
  check(transferReceived.status === 202, "Cloud transfer event was rejected");
  const inboxResponse = await fetch(`${base}/sync/inbox?after=0`, {
    headers: {
      authorization: "Bearer verify-branch-token-unique",
      "x-branch-id": "BR-VERIFY-01",
      "x-device-token": "verify-device-token-unique",
    },
  });
  const inbox = await inboxResponse.json();
  check(
    inboxResponse.ok &&
      inbox.events.some(
        (event) => event.event_id === transferSyncEvent.eventId,
      ) &&
      inbox.cursor > 0,
    "Authenticated cloud transfer inbox did not return the event",
  );
  const session = await post("/auth/login", null, {
    username: "admin",
    password,
  });
  check(session.user.isSuperAdmin, "Bootstrap owner is not Super Admin");
  const token = session.token;
  const baristaSession = await post("/auth/login", null, {
    username: "Barista",
    password: "Barista-demo#2026!B4r",
  });
  const baristaToken = baristaSession.token;
  const roleCreated = await post("/roles", token, {
    name: "Integration operator",
    nameAr: "مشغّل التحقق",
    description: "Created by verification",
    permissions: ["pos.access"],
  });
  await request("PATCH", `/roles/${roleCreated.id}`, token, {
    name: "Integration operator edited",
    nameAr: "مشغّل التحقق المعدل",
    description: "Updated by verification",
    permissions: ["pos.access", "sales.view"],
  });
  const staffAfterRoleEdit = await get("/staff", token);
  check(
    staffAfterRoleEdit.roles.some(
      (item) =>
        item.id === roleCreated.id &&
        item.name === "Integration operator edited" &&
        item.permissions.split(",").includes("sales.view"),
    ),
    "Custom role edits did not persist",
  );
  const roleEmployeePassword = "RoleRefresh#2026";
  await post("/staff", token, {
    name: "Role Refresh Employee",
    nameAr: "موظف تحديث الصلاحيات",
    username: "role-refresh",
    password: roleEmployeePassword,
    roleId: roleCreated.id,
    branchId: "BR-VERIFY-01",
  });
  const roleEmployeeSession = await post("/auth/login", null, {
    username: "role-refresh",
    password: roleEmployeePassword,
  });
  await get("/orders", roleEmployeeSession.token);
  await request("PATCH", `/roles/${roleCreated.id}`, token, {
    permissions: ["pos.access"],
  });
  const revokedAccess = await fetch(`${base}/orders`, {
    headers: { authorization: `Bearer ${roleEmployeeSession.token}` },
  });
  check(
    revokedAccess.status === 403,
    "Role permission changes did not take effect for an existing session",
  );
  await request("PATCH", `/roles/${roleCreated.id}`, token, {
    permissions: ["pos.access", "sales.view"],
  });
  const cloudOverview = await get("/cloud/overview", token);
  check(
    cloudOverview.enabled &&
      cloudOverview.summary.revenue === 12345 &&
      cloudOverview.summary.transactions === 1,
    "Cloud overview did not aggregate received events",
  );
  const cloudReport = await get(
    `/cloud/reports?from=${new Date().toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`,
    token,
  );
  check(
    cloudReport.source === "cloud" && cloudReport.summary.revenue === 12345,
    "Cloud report did not aggregate synchronized branch sales",
  );
  await request("PUT", "/settings/receipt", token, {
    footer: "Integration receipt",
    autoPrint: false,
    bilingual: true,
    showBranch: true,
    drawerTrigger: "printer",
  });
  const settings = await get("/settings", token);
  check(
    settings.settings.receipt.footer === "Integration receipt",
    "Receipt configuration did not persist",
  );
  const customerCreated = await post("/customers", token, {
    name: "Integration Customer",
    phone: "01000000000",
    creditApproved: true,
    creditLimit: 100000,
  });
  await request("PATCH", `/customers/${customerCreated.id}`, token, {
    notes: "Verified account",
  });
  const customerProfile = await get(
    `/customers/${customerCreated.id}/profile`,
    token,
  );
  check(
    customerProfile.customer.notes === "Verified account" &&
      customerProfile.transactions.length === 0,
    "Customer profile history did not load",
  );
  const branchCreated = await post("/branches", token, {
    code: "VRF02",
    name: "Verify Two",
    nameAr: "فرع التحقق",
    address: "Test address",
  });
  await request("PATCH", `/branches/${branchCreated.id}`, token, {
    phone: "01011111111",
    notes: "Integration branch",
  });
  const branches = await get("/branches", token);
  check(
    branches.branches.some(
      (branch) =>
        branch.id === branchCreated.id && branch.phone === "01011111111",
    ),
    "Branch management did not persist edits",
  );
  await post("/treasury/movements", token, {
    direction: "in",
    type: "owner_deposit",
    category: "Capital",
    amount: 50000,
    paymentMethod: "cash",
    description: "Integration deposit",
  });
  await post(`/staff/${session.user.id}/ledger`, token, {
    type: "bonus",
    amount: 1000,
    note: "Integration bonus",
  });
  const employeeProfile = await get(`/staff/${session.user.id}/profile`, token);
  check(
    employeeProfile.ledger.some((entry) => entry.note === "Integration bonus"),
    "Employee ledger entry did not persist",
  );
  const catalog = await get("/catalog", baristaToken);
  let context = await get("/pos/context", baristaToken);
  if (!context.shift) {
    await post("/shifts/open", baristaToken, { openingCash: 10000 });
    context = await get("/pos/context", baristaToken);
  }
  check(
    catalog.products.length >= 14 && context.shift?.id,
    "Seed catalog or shift is missing",
  );
  const product = catalog.products.find((item) => item.sku === "COF-001");
  check(product, "Seeded Turkish Coffee is missing");
  const variant = catalog.variants.find(
    (item) => item.product_id === product.id && item.name === "Double",
  );
  check(variant, "Seeded Turkish Coffee variant is missing");
  const createdVariant = await post(`/products/${product.id}/variants`, token, {
    name: "Integration size",
    nameAr: "حجم التحقق",
    price: 3000,
    cost: 900,
    sku: "INT-VARIANT-01",
    stock: 3,
    lowStockAt: 1,
    trackStock: true,
  });
  await request("PATCH", `/variants/${createdVariant.id}`, token, {
    price: 3200,
    stock: 4,
  });
  const managedCatalog = await get("/admin/catalog", token);
  check(
    managedCatalog.variants.some(
      (item) =>
        item.id === createdVariant.id &&
        item.price === 3200 &&
        item.stock === 4,
    ),
    "Variant management did not persist edits",
  );
  const firstRecipeIngredient = await post("/inventory/items", token, {
    sku: "INT-RECIPE-01",
    name: "Integration recipe one",
    nameAr: "مكون تحقق أول",
    unit: "grams",
    stockQuantity: 1000,
    lowStockAt: 100,
    costPerUnit: 1,
  });
  const secondRecipeIngredient = await post("/inventory/items", token, {
    sku: "INT-RECIPE-02",
    name: "Integration recipe two",
    nameAr: "مكون تحقق ثان",
    unit: "milliliters",
    stockQuantity: 1000,
    lowStockAt: 100,
    costPerUnit: 1,
  });
  const baseIngredient = {
    id: firstRecipeIngredient.id,
    unit: "grams",
    stock_quantity: 1000,
  };
  const secondBaseIngredient = {
    id: secondRecipeIngredient.id,
    unit: "milliliters",
    stock_quantity: 1000,
  };
  const recipeProduct = await post("/products", token, {
    categoryId: product.category_id,
    sku: "INT-RECIPE-PRODUCT",
    name: "Integration recipe product",
    nameAr: "منتج تحقق الوصفة",
    price: 2500,
    cost: 800,
    trackStock: false,
    recipeComponents: [
      {
        ingredientId: baseIngredient.id,
        quantity: 3,
        unit: baseIngredient.unit,
      },
      {
        ingredientId: secondBaseIngredient.id,
        quantity: 1,
        unit: secondBaseIngredient.unit,
      },
    ],
  });
  await request("PATCH", `/products/${product.id}`, token, {
    recipeComponents: [
      {
        ingredientId: baseIngredient.id,
        quantity: 5,
        unit: baseIngredient.unit,
      },
      {
        ingredientId: secondBaseIngredient.id,
        quantity: 2,
        unit: secondBaseIngredient.unit,
      },
    ],
  });
  const catalogWithBaseRecipe = await get("/admin/catalog", token);
  check(
    catalogWithBaseRecipe.recipes.filter(
      (recipe) => recipe.product_id === recipeProduct.id,
    ).length === 2,
    "Creating a product with multiple recipe ingredients did not persist",
  );
  check(
    catalogWithBaseRecipe.recipes.filter(
      (recipe) => recipe.product_id === product.id && recipe.variant_id === null,
    ).length === 2 &&
      catalogWithBaseRecipe.recipes.some(
        (recipe) =>
          recipe.product_id === product.id &&
          recipe.variant_id === null &&
          recipe.inventory_item_id === baseIngredient.id &&
          recipe.quantity === 5,
      ) &&
      catalogWithBaseRecipe.recipes.some(
        (recipe) =>
          recipe.product_id === product.id &&
          recipe.variant_id === null &&
          recipe.inventory_item_id === secondBaseIngredient.id &&
          recipe.quantity === 2,
      ),
    "Multi-ingredient base recipe did not persist",
  );
  const held = await post("/orders/hold", baristaToken, {
    shiftId: context.shift.id,
    note: "Verification hold",
    items: [
      { productId: product.id, variantId: variant.id, quantity: 1, note: "" },
    ],
    activityLog: [],
  });
  const clientRequestId = crypto.randomUUID();
  const checkout = {
    clientRequestId,
    shiftId: context.shift.id,
    heldOrderId: held.id,
    paymentMethod: "cash",
    discountAmount: 0,
    note: "Verification sale",
    activityLog: [
      {
        action: "item.quantity_changed",
        productId: product.id,
        originalValue: { quantity: 1 },
        newValue: { quantity: 2 },
        occurredAt: new Date().toISOString(),
      },
    ],
    items: [
      {
        productId: product.id,
        variantId: variant.id,
        quantity: 2,
        unitPrice: 1,
        note: "",
      },
    ],
  };
  const sale = await post("/orders/checkout", baristaToken, checkout);
  const replay = await post("/orders/checkout", baristaToken, checkout);
  check(
    sale.order.subtotal === variant.price * 2,
    "Checkout did not enforce the server variant price",
  );
  check(replay.idempotentReplay, "Checkout retry created a duplicate");
  const inventoryAfterMultiIngredientSale = await get("/inventory", token);
  const baseIngredientAfterSale = inventoryAfterMultiIngredientSale.ingredients.find(
    (ingredient) => ingredient.id === baseIngredient.id,
  );
  const secondBaseIngredientAfterSale =
    inventoryAfterMultiIngredientSale.ingredients.find(
      (ingredient) => ingredient.id === secondBaseIngredient.id,
    );
  check(
    baseIngredientAfterSale.stock_quantity ===
      baseIngredient.stock_quantity - 10 &&
      secondBaseIngredientAfterSale.stock_quantity ===
        secondBaseIngredient.stock_quantity - 4,
    "Checkout did not deduct every base recipe ingredient by sale quantity",
  );
  const detail = await get(`/orders/${sale.order.id}`, token);
  check(
    detail.order.history.some(
      (event) => event.action === "item.quantity_changed",
    ),
    "Cart mutation audit is missing",
  );
  const voided = await post(`/orders/${sale.order.id}/void`, token, {
    reason: "Automated integration verification",
  });
  check(voided.order.status === "voided", "Void did not complete");
  const refundCheckout = {
    ...checkout,
    clientRequestId: crypto.randomUUID(),
    heldOrderId: undefined,
    items: [
      {
        productId: product.id,
        variantId: variant.id,
        quantity: 1,
        unitPrice: 1,
        note: "",
      },
    ],
    activityLog: [],
  };
  const refundableSale = await post("/orders/checkout", baristaToken, refundCheckout);
  const refund = await post(
    `/orders/${refundableSale.order.id}/refund`,
    token,
    { reason: "Automated refund verification" },
  );
  check(
    refund.refund.status === "refunded" &&
      refund.refund.amount === variant.price,
    "Refund did not reverse the full sale",
  );
  const refundedDetail = await get(`/orders/${refundableSale.order.id}`, token);
  check(
    refundedDetail.order.status === "refunded" &&
      refundedDetail.order.history.some(
        (event) => event.action === "order.refunded",
      ),
    "Refund history or derived status is missing",
  );
  const transfer = await post("/inventory/transfers", token, {
    itemType: "product",
    itemId: product.id,
    destinationBranchId: branchCreated.id,
    quantity: 2,
    reason: "Automated inter-branch transfer verification",
  });
  check(
    transfer.transfer.status === "dispatched" &&
      transfer.transfer.destinationBranchId === branchCreated.id,
    "Branch stock transfer did not dispatch",
  );
  const inventory = await get("/inventory", token);
  check(
    inventory.movements.length === 5 &&
      inventory.transfers.some((item) => item.id === transfer.transfer.id),
    "Sale reversals or branch transfer movements are missing",
  );
  check(
    inventory.ingredientMovements.length >= 12 &&
      inventory.ingredientMovements.some(
        (movement) => movement.type === "refund_return",
      ),
    "Variant ingredient refund restoration is incorrect",
  );
  const outbox = await get("/sync/status", token);
  check(
    outbox.mode === "cloud"
      ? outbox.pending === 0 && outbox.state === "synced"
      : outbox.pending >= 2,
    "Synchronization status did not match the server mode",
  );
  const treasury = await get("/treasury", token);
  check(
    treasury.shifts.length >= 1 &&
      treasury.movements.some((movement) => movement.type === "owner_deposit"),
    "Treasury history or manual movement is missing",
  );
  const report = await get(
    `/reports/summary?paymentMethod=cash&productId=${product.id}`,
    token,
  );
  check(
    Array.isArray(report.branchComparison) &&
      report.customerOutstanding &&
      Array.isArray(report.employeeAudit) &&
      report.filters.products.some((item) => item.id === product.id) &&
      report.summary.refunds === 1,
    "Expanded report dimensions or refund totals did not load",
  );
  console.log(
    JSON.stringify(
      {
        status: "passed",
        products: catalog.products.length,
        orderNumber: sale.order.orderNumber,
        variant: variant.name,
        variantManagement: true,
        baseProductRecipes: true,
        editableRoles: true,
        immediatePermissionRefresh: true,
        expandedReports: true,
        refunds: true,
        estimatedIngredientUsageGrams: 28,
        customerProfile: true,
        employeeLedger: true,
        branchManagement: true,
        receiptConfiguration: true,
        treasuryHistory: true,
        cloudReceiverIdempotency: true,
        cloudTransferInbox: true,
        remoteOverview: true,
        remoteReports: true,
        idempotentReplay: true,
        voided: true,
        inventoryMovements: inventory.movements.length,
        queuedSyncEvents: outbox.pending,
      },
      null,
      2,
    ),
  );
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(tempDirectory, { recursive: true, force: true });
}
