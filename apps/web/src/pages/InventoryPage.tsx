import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  History,
  PackageCheck,
  Plus,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { formatMoney } from "@token-taste/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { useI18n } from "../i18n";
import { StatusBadge } from "../components/StatusBadge";

type InventoryProduct = {
  id: string;
  sku: string;
  name: string;
  name_ar: string;
  price: number;
  cost: number;
  stock: number;
  low_stock_at: number;
  category_name: string;
  category_name_ar: string;
  track_stock: number;
  active: number;
};
type Movement = {
  id: string;
  type: string;
  quantity: number;
  before_quantity: number;
  after_quantity: number;
  reason: string;
  created_at: string;
  product_name: string;
  user_name: string;
  user_name_ar: string;
};
type Ingredient = {
  id: string;
  sku: string;
  name: string;
  name_ar: string;
  unit: string;
  stock_quantity: number;
  low_stock_at: number;
  cost_per_unit: number;
  active: number;
};
type IngredientMovement = {
  id: string;
  type: string;
  quantity: number;
  before_quantity: number;
  after_quantity: number;
  reason: string;
  created_at: string;
  ingredient_name: string;
  unit: string;
  user_name: string;
  user_name_ar: string;
};
type Branch = { id: string; name: string; name_ar: string };
type Transfer = {
  id: string;
  item_type: string;
  item_name: string;
  destination_name: string;
  destination_name_ar: string;
  quantity: number;
  unit: string;
  status: string;
  reason: string;
  user_name: string;
  user_name_ar: string;
  created_at: string;
};
type IncomingTransfer = {
  id: string;
  source_name: string | null;
  source_name_ar: string | null;
  source_branch_id: string;
  item_type: string;
  item_name: string;
  quantity: number;
  unit: string;
  reason: string;
  received_at: string;
};

export function InventoryPage() {
  const { user } = useAuth();
  const { language, t } = useI18n();
  const [products, setProducts] = useState<InventoryProduct[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [ingredientMovements, setIngredientMovements] = useState<
    IngredientMovement[]
  >([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<InventoryProduct | null>(null);
  const [selectedIngredient, setSelectedIngredient] =
    useState<Ingredient | null>(null);
  const [quantity, setQuantity] = useState(0);
  const [reason, setReason] = useState("");
  const [movementType, setMovementType] = useState("adjustment");
  const [destinationBranchId, setDestinationBranchId] = useState("");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [incomingTransfers, setIncomingTransfers] = useState<
    IncomingTransfer[]
  >([]);
  const [itemOpen, setItemOpen] = useState(false);
  const [itemForm, setItemForm] = useState({
    sku: "",
    name: "",
    nameAr: "",
    unit: "grams",
    stockQuantity: 0,
    lowStockAt: 0,
    costPerUnit: 0,
  });
  const [tab, setTab] = useState<
    "stock" | "ingredients" | "movements" | "transfers"
  >("stock");
  const load = () =>
    api<{
      products: InventoryProduct[];
      movements: Movement[];
      ingredients: Ingredient[];
      ingredientMovements: IngredientMovement[];
      branches: Branch[];
      transfers: Transfer[];
      incomingTransfers: IncomingTransfer[];
    }>("/api/inventory").then((data) => {
      setProducts(data.products);
      setMovements(data.movements);
      setIngredients(data.ingredients);
      setIngredientMovements(data.ingredientMovements);
      setBranches(data.branches);
      setTransfers(data.transfers);
      setIncomingTransfers(data.incomingTransfers);
    });
  useEffect(() => {
    void load();
  }, []);
  const filtered = useMemo(
    () =>
      products.filter((product) =>
        `${product.name} ${product.name_ar} ${product.sku}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [products, search],
  );
  const adjust = async () => {
    if (!selected) return;
    if (movementType === "transfer") {
      await api("/api/inventory/transfers", {
        method: "POST",
        body: JSON.stringify({
          itemType: "product",
          itemId: selected.id,
          destinationBranchId,
          quantity,
          reason,
        }),
      });
      setSelected(null);
      setQuantity(0);
      setReason("");
      setDestinationBranchId("");
      await load();
      return;
    }
    await api(`/api/inventory/${selected.id}/adjust`, {
      method: "POST",
      body: JSON.stringify({ quantity, reason, type: movementType }),
    });
    setSelected(null);
    setQuantity(0);
    setReason("");
    await load();
  };
  const adjustIngredient = async () => {
    if (!selectedIngredient) return;
    if (movementType === "transfer") {
      await api("/api/inventory/transfers", {
        method: "POST",
        body: JSON.stringify({
          itemType: "ingredient",
          itemId: selectedIngredient.id,
          destinationBranchId,
          quantity,
          reason,
        }),
      });
      setSelectedIngredient(null);
      setQuantity(0);
      setReason("");
      setDestinationBranchId("");
      await load();
      return;
    }
    await api(`/api/inventory/items/${selectedIngredient.id}/adjust`, {
      method: "POST",
      body: JSON.stringify({ quantity, reason, type: movementType }),
    });
    setSelectedIngredient(null);
    setQuantity(0);
    setReason("");
    await load();
  };
  const createItem = async (event: React.FormEvent) => {
    event.preventDefault();
    await api("/api/inventory/items", {
      method: "POST",
      body: JSON.stringify({
        ...itemForm,
        costPerUnit: Math.round(itemForm.costPerUnit * 100),
      }),
    });
    setItemOpen(false);
    setItemForm({
      sku: "",
      name: "",
      nameAr: "",
      unit: "grams",
      stockQuantity: 0,
      lowStockAt: 0,
      costPerUnit: 0,
    });
    await load();
  };
  const totalValue = products.reduce(
    (sum, product) => sum + product.cost * product.stock,
    0,
  );
  const lowCount =
    products.filter((product) => product.stock <= product.low_stock_at).length +
    ingredients.filter((item) => item.stock_quantity <= item.low_stock_at)
      .length;
  return (
    <div className="content-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Stock control</span>
          <h2>{t("inventory")}</h2>
          <p>Live quantities, adjustments, and a complete movement trail.</p>
        </div>
        <button className="primary-button" onClick={() => setItemOpen(true)}>
          <Plus size={18} /> Add ingredient
        </button>
      </div>
      <div className="mini-metrics">
        <article>
          <span>
            <Boxes />
          </span>
          <div>
            <small>Tracked products</small>
            <strong>{products.length}</strong>
          </div>
        </article>
        <article>
          <span className="warning">
            <SlidersHorizontal />
          </span>
          <div>
            <small>{t("lowStock")}</small>
            <strong>{lowCount}</strong>
          </div>
        </article>
        <article>
          <span className="success">
            <PackageCheck />
          </span>
          <div>
            <small>Stock value</small>
            <strong>{formatMoney(totalValue, language)}</strong>
          </div>
        </article>
      </div>
      <section className="panel table-panel">
        <div className="table-toolbar">
          <div className="segmented">
            <button
              className={tab === "stock" ? "active" : ""}
              onClick={() => setTab("stock")}
            >
              <Boxes size={16} /> Packaged stock
            </button>
            <button
              className={tab === "ingredients" ? "active" : ""}
              onClick={() => setTab("ingredients")}
            >
              <PackageCheck size={16} /> Ingredients
            </button>
            <button
              className={tab === "movements" ? "active" : ""}
              onClick={() => setTab("movements")}
            >
              <History size={16} /> Movement history
            </button>
            <button
              className={tab === "transfers" ? "active" : ""}
              onClick={() => setTab("transfers")}
            >
              <ArrowUpRight size={16} /> Branch transfers
            </button>
          </div>
          <label>
            <Search size={18} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search stock"
            />
          </label>
        </div>
        {tab === "stock" ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("product")}</th>
                  <th>SKU</th>
                  <th>{t("category")}</th>
                  <th>Unit cost</th>
                  <th>{t("stock")}</th>
                  <th>{t("status")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((product) => {
                  const status =
                    product.stock <= 0
                      ? "Out of stock"
                      : product.stock <= product.low_stock_at
                        ? "Low stock"
                        : "In stock";
                  return (
                    <tr key={product.id}>
                      <td>
                        <strong>
                          {language === "ar" ? product.name_ar : product.name}
                        </strong>
                        <small>
                          {formatMoney(product.price, language)} retail
                        </small>
                      </td>
                      <td>
                        <code>{product.sku}</code>
                      </td>
                      <td>{language === "ar" ? product.category_name_ar : product.category_name}</td>
                      <td>{formatMoney(product.cost, language)}</td>
                      <td>
                        <strong>{product.stock}</strong> units
                      </td>
                      <td>
                        <StatusBadge value={status} />
                      </td>
                      <td>
                        <button
                          className="soft-button small"
                          onClick={() => setSelected(product)}
                        >
                          {t("adjust")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : tab === "ingredients" ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ingredient</th>
                  <th>SKU</th>
                  <th>Unit</th>
                  <th>Current stock</th>
                  <th>Low at</th>
                  <th>Estimated value</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ingredients
                  .filter((item) =>
                    `${item.name} ${item.name_ar} ${item.sku}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>
                          {language === "ar" ? item.name_ar : item.name}
                        </strong>
                        <small>
                          {language === "ar" ? item.name : item.name_ar}
                        </small>
                      </td>
                      <td>
                        <code>{item.sku}</code>
                      </td>
                      <td className="capitalize">{item.unit}</td>
                      <td>
                        <strong>{item.stock_quantity.toLocaleString()}</strong>{" "}
                        {item.unit}
                      </td>
                      <td>{item.low_stock_at.toLocaleString()}</td>
                      <td>
                        {formatMoney(
                          Math.round(item.stock_quantity * item.cost_per_unit),
                          language,
                        )}
                      </td>
                      <td>
                        <button
                          className="soft-button small"
                          onClick={() => setSelectedIngredient(item)}
                        >
                          {t("adjust")}
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : tab === "movements" ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("time")}</th>
                  <th>Item</th>
                  <th>Movement</th>
                  <th>Before → After</th>
                  <th>{t("user")}</th>
                  <th>{t("reason")}</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ...movements.map((m) => ({
                    ...m,
                    item_name: m.product_name,
                    unit: "pieces",
                  })),
                  ...ingredientMovements.map((m) => ({
                    ...m,
                    item_name: m.ingredient_name,
                  })),
                ]
                  .sort((a, b) => b.created_at.localeCompare(a.created_at))
                  .map((movement) => (
                    <tr key={movement.id}>
                      <td>{new Date(movement.created_at).toLocaleString(language === "ar" ? "ar-EG" : "en-EG")}</td>
                      <td>
                        <strong>{movement.item_name}</strong>
                      </td>
                      <td>
                        <span
                          className={`movement ${movement.quantity > 0 ? "movement--in" : "movement--out"}`}
                        >
                          {movement.quantity > 0 ? (
                            <ArrowUpRight />
                          ) : (
                            <ArrowDownRight />
                          )}
                          {movement.quantity > 0 ? "+" : ""}
                          {movement.quantity} {movement.unit}
                        </span>
                      </td>
                      <td>
                        {movement.before_quantity} →{" "}
                        <strong>{movement.after_quantity}</strong>
                      </td>
                      <td>{language === "ar" ? movement.user_name_ar : movement.user_name}</td>
                      <td>
                        {movement.reason || movement.type.replaceAll("_", " ")}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="transfer-tables">
            <div className="table-wrap">
              <h3>Outgoing transfers</h3>
              <table>
                <thead>
                  <tr>
                    <th>Dispatched</th>
                    <th>Item</th>
                    <th>Destination</th>
                    <th>Quantity</th>
                    <th>Status</th>
                    <th>User</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {transfers.map((transfer) => (
                    <tr key={transfer.id}>
                      <td>{new Date(transfer.created_at).toLocaleString(language === "ar" ? "ar-EG" : "en-EG")}</td>
                      <td>
                        <strong>{transfer.item_name}</strong>
                        <small className="capitalize">
                          {transfer.item_type}
                        </small>
                      </td>
                      <td>{language === "ar" ? transfer.destination_name_ar : transfer.destination_name}</td>
                      <td>
                        {transfer.quantity} {transfer.unit}
                      </td>
                      <td>
                        <StatusBadge value={transfer.status} />
                      </td>
                      <td>{language === "ar" ? transfer.user_name_ar : transfer.user_name}</td>
                      <td>{transfer.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-wrap">
              <h3>Received transfers</h3>
              <table>
                <thead>
                  <tr>
                    <th>Received</th>
                    <th>Item</th>
                    <th>Source</th>
                    <th>Quantity</th>
                    <th>Status</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {incomingTransfers.map((transfer) => (
                    <tr key={transfer.id}>
                      <td>{new Date(transfer.received_at).toLocaleString(language === "ar" ? "ar-EG" : "en-EG")}</td>
                      <td>
                        <strong>{transfer.item_name}</strong>
                        <small className="capitalize">
                          {transfer.item_type}
                        </small>
                      </td>
                      <td>
                        {(language === "ar" ? transfer.source_name_ar : transfer.source_name) || transfer.source_branch_id}
                      </td>
                      <td>
                        {transfer.quantity} {transfer.unit}
                      </td>
                      <td>
                        <StatusBadge value="received" />
                      </td>
                      <td>{transfer.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
      {(selected || selectedIngredient) && (
        <div className="modal-backdrop">
          <section className="modal compact-modal">
            <header>
              <div>
                <span>
                  <SlidersHorizontal />
                </span>
                <div>
                  <h2>{t("adjust")}</h2>
                  <p>
                    {selected
                      ? language === "ar"
                        ? selected.name_ar
                        : selected.name
                      : language === "ar"
                        ? selectedIngredient?.name_ar
                        : selectedIngredient?.name}{" "}
                    · Current:{" "}
                    {selected?.stock ?? selectedIngredient?.stock_quantity}
                  </p>
                </div>
              </div>
              <button
                className="icon-button"
                onClick={() => {
                  setSelected(null);
                  setSelectedIngredient(null);
                }}
              >
                <X />
              </button>
            </header>
            <label className="field">
              <span>Movement type</span>
              <select
                value={movementType}
                onChange={(e) => {
                  setMovementType(e.target.value);
                  setQuantity(0);
                  setDestinationBranchId("");
                }}
              >
                <option value="receipt">Stock receipt</option>
                <option value="adjustment">Manual adjustment</option>
                <option value="wastage">Wastage</option>
                <option value="damaged">Damaged</option>
                <option value="transfer">Branch transfer</option>
              </select>
            </label>
            {movementType === "transfer" && (
              <label className="field">
                <span>Destination branch</span>
                <select
                  required
                  value={destinationBranchId}
                  onChange={(e) => setDestinationBranchId(e.target.value)}
                >
                  <option value="">Select another branch</option>
                  {branches
                    .filter((branch) => branch.id !== user?.branchId)
                    .map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {language === "ar" ? branch.name_ar : branch.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <label className="field">
              <span>
                {movementType === "transfer"
                  ? "Quantity to send"
                  : "Quantity change"}
              </span>
              <input
                type="number"
                min={
                  movementType === "transfer"
                    ? selectedIngredient
                      ? 0.01
                      : 1
                    : undefined
                }
                step={selectedIngredient ? "0.01" : "1"}
                value={quantity}
                onChange={(event) => setQuantity(Number(event.target.value))}
              />
              <small>
                {movementType === "transfer"
                  ? "The quantity is deducted locally and queued for the destination branch."
                  : "Use a negative number for wastage, damage, or removal."}
              </small>
            </label>
            <label className="field">
              <span>{t("reason")}</span>
              <textarea
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Required for the audit trail"
              />
            </label>
            <div className="stock-preview">
              <span>New quantity</span>
              <strong>
                {(selected?.stock ?? selectedIngredient?.stock_quantity ?? 0) +
                  (movementType === "transfer" ? -quantity : quantity)}
              </strong>
            </div>
            <div className="modal-actions">
              <button
                className="soft-button"
                onClick={() => {
                  setSelected(null);
                  setSelectedIngredient(null);
                }}
              >
                {t("cancel")}
              </button>
              <button
                className="primary-button"
                disabled={
                  !quantity ||
                  !reason.trim() ||
                  (movementType === "transfer" && !destinationBranchId) ||
                  (movementType === "transfer" && quantity <= 0) ||
                  (selected?.stock ?? selectedIngredient?.stock_quantity ?? 0) +
                    (movementType === "transfer" ? -quantity : quantity) <
                    0
                }
                onClick={selected ? adjust : adjustIngredient}
              >
                {t("save")}
              </button>
            </div>
          </section>
        </div>
      )}
      {itemOpen && (
        <div className="modal-backdrop">
          <form className="modal compact-modal" onSubmit={createItem}>
            <header>
              <div>
                <span>
                  <PackageCheck />
                </span>
                <div>
                  <h2>Add ingredient</h2>
                  <p>Create a measured raw-material stock item.</p>
                </div>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setItemOpen(false)}
              >
                <X />
              </button>
            </header>
            <div className="field-row">
              <label className="field">
                <span>English name</span>
                <input
                  required
                  value={itemForm.name}
                  onChange={(e) =>
                    setItemForm({ ...itemForm, name: e.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>الاسم بالعربية</span>
                <input
                  required
                  dir="rtl"
                  value={itemForm.nameAr}
                  onChange={(e) =>
                    setItemForm({ ...itemForm, nameAr: e.target.value })
                  }
                />
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>SKU</span>
                <input
                  required
                  value={itemForm.sku}
                  onChange={(e) =>
                    setItemForm({ ...itemForm, sku: e.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Measurement unit</span>
                <select
                  value={itemForm.unit}
                  onChange={(e) =>
                    setItemForm({ ...itemForm, unit: e.target.value })
                  }
                >
                  <option>grams</option>
                  <option>kilograms</option>
                  <option>milliliters</option>
                  <option>liters</option>
                  <option>pieces</option>
                </select>
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>Opening quantity</span>
                <input
                  type="number"
                  min="0"
                  step=".01"
                  value={itemForm.stockQuantity || ""}
                  onChange={(e) =>
                    setItemForm({
                      ...itemForm,
                      stockQuantity: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Low-stock alert</span>
                <input
                  type="number"
                  min="0"
                  step=".01"
                  value={itemForm.lowStockAt || ""}
                  onChange={(e) =>
                    setItemForm({
                      ...itemForm,
                      lowStockAt: Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>
            <label className="field">
              <span>Cost per {itemForm.unit} (EGP)</span>
              <input
                type="number"
                min="0"
                step=".01"
                value={itemForm.costPerUnit || ""}
                onChange={(e) =>
                  setItemForm({
                    ...itemForm,
                    costPerUnit: Number(e.target.value),
                  })
                }
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="soft-button"
                onClick={() => setItemOpen(false)}
              >
                {t("cancel")}
              </button>
              <button className="primary-button">Create ingredient</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
