import { useEffect, useState } from "react";
import {
  Eye,
  Filter,
  Printer,
  ReceiptText,
  RotateCcw,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import { formatMoney } from "@token-taste/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { useI18n } from "../i18n";
import { StatusBadge } from "../components/StatusBadge";

type OrderRow = {
  id: string;
  order_number: string;
  status: string;
  payment_method: string;
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total: number;
  refunded_amount: number;
  created_at: string;
  sync_status: string;
  user_name: string;
  user_name_ar: string;
  customer_name: string | null;
};
type OrderDetail = OrderRow & {
  items: Array<{
    id: string;
    product_name: string;
    product_name_ar: string;
    variant_name: string | null;
    variant_name_ar: string | null;
    quantity: number;
    unit_price: number;
    total: number;
  }>;
  history: Array<{
    id: string;
    action: string;
    created_at: string;
    reason: string | null;
  }>;
};

export function OrdersPage() {
  const { can } = useAuth();
  const { language, t } = useI18n();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<OrderDetail | null>(null);
  const [actionReason, setActionReason] = useState("");
  const [reversalAction, setReversalAction] = useState<
    "void" | "refund" | null
  >(null);
  const money = (value: number) => formatMoney(value, language);

  const load = () =>
    api<{ orders: OrderRow[] }>(
      `/api/orders?status=${filter}&search=${encodeURIComponent(search)}`,
    ).then((data) => setOrders(data.orders));
  useEffect(() => {
    void load();
  }, [filter]);
  const inspect = async (id: string) =>
    setSelected((await api<{ order: OrderDetail }>(`/api/orders/${id}`)).order);
  const reverseOrder = async () => {
    if (!selected || !reversalAction) return;
    await api(`/api/orders/${selected.id}/${reversalAction}`, {
      method: "POST",
      body: JSON.stringify({ reason: actionReason }),
    });
    setReversalAction(null);
    setActionReason("");
    setSelected(null);
    await load();
  };
  const reprint = async () => {
    if (!selected) return;
    await api(`/api/orders/${selected.id}/reprint`, { method: "POST" });
    window.print();
  };
  const exportCsv = () => {
    const escape = (value: unknown) =>
      `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [
      "Order,Date,Employee,Customer,Payment,Amount,Status",
      ...orders.map((order) =>
        [
          order.order_number,
          order.created_at,
          order.user_name,
          order.customer_name ?? "Walk-in",
          order.payment_method,
          (order.total / 100).toFixed(2),
          order.status,
        ]
          .map(escape)
          .join(","),
      ),
    ].join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    link.download = `talk-and-taste-orders-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="content-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Sales & accountability</span>
          <h2>{t("orders")}</h2>
          <p>Every completed, changed, and voided transaction in one place.</p>
        </div>
        <button className="soft-button" onClick={exportCsv}>
          <Filter size={18} /> Export report
        </button>
      </div>
      <section className="panel table-panel">
        <div className="table-toolbar">
          <label>
            <Search size={18} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && load()}
              placeholder="Search order or customer"
            />
          </label>
          <div className="segmented">
            {["all", "completed", "refunded", "voided", "held"].map(
              (status) => (
                <button
                  key={status}
                  className={filter === status ? "active" : ""}
                  onClick={() => setFilter(status)}
                >
                  {status}
                </button>
              ),
            )}
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("orderNumber")}</th>
                <th>{t("time")}</th>
                <th>{t("user")}</th>
                <th>{t("customer")}</th>
                <th>{t("payment")}</th>
                <th>{t("amount")}</th>
                <th>{t("status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td>
                    <strong>#{order.order_number}</strong>
                  </td>
                  <td>
                    {new Date(order.created_at).toLocaleString(
                      language === "ar" ? "ar-EG" : "en-EG",
                      {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      },
                    )}
                  </td>
                  <td>{language === "ar" ? order.user_name_ar : order.user_name}</td>
                  <td>{order.customer_name ?? "Walk-in"}</td>
                  <td className="capitalize">{order.payment_method}</td>
                  <td>
                    <strong>{money(order.total)}</strong>
                    {order.discount_amount > 0 && (
                      <small>−{money(order.discount_amount)} discount</small>
                    )}
                    {order.refunded_amount > 0 && (
                      <small>−{money(order.refunded_amount)} refunded</small>
                    )}
                  </td>
                  <td>
                    <StatusBadge value={order.status} />
                  </td>
                  <td>
                    <button
                      className="icon-button"
                      onClick={() => inspect(order.id)}
                    >
                      <Eye size={18} />
                    </button>
                  </td>
                </tr>
              ))}
              {!orders.length && (
                <tr>
                  <td colSpan={8}>
                    <div className="table-empty-state">
                      <ReceiptText />
                      <strong>No transactions found</strong>
                      <p>Sales from this branch will appear here.</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      {selected && (
        <div className="drawer-backdrop" onClick={() => setSelected(null)}>
          <aside
            className="detail-drawer"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="eyebrow">Transaction details</span>
                <h2>#{selected.order_number}</h2>
              </div>
              <button className="icon-button" onClick={() => setSelected(null)}>
                <X />
              </button>
            </header>
            <div className="detail-meta">
              <div>
                <span>{t("status")}</span>
                <StatusBadge value={selected.status} />
              </div>
              <div>
                <span>{t("time")}</span>
                <strong>
                  {new Date(selected.created_at).toLocaleString(language === "ar" ? "ar-EG" : "en-EG")}
                </strong>
              </div>
              <div>
                <span>{t("user")}</span>
                <strong>{language === "ar" ? selected.user_name_ar : selected.user_name}</strong>
              </div>
              <div>
                <span>{t("payment")}</span>
                <strong className="capitalize">
                  {selected.payment_method}
                </strong>
              </div>
            </div>
            <div className="drawer-section">
              <h3>Items</h3>
              {selected.items.map((item) => (
                <div className="line-item" key={item.id}>
                  <span>{item.quantity}×</span>
                  <div>
                    <strong>
                      {language === "ar"
                        ? item.product_name_ar
                        : item.product_name}
                    </strong>
                    <small>
                      {item.variant_name
                        ? `${language === "ar" ? item.variant_name_ar : item.variant_name} · `
                        : ""}
                      {money(item.unit_price)} each
                    </small>
                  </div>
                  <b>{money(item.total)}</b>
                </div>
              ))}
            </div>
            <div className="drawer-total">
              <div>
                <span>{t("subtotal")}</span>
                <b>{money(selected.subtotal)}</b>
              </div>
              <div>
                <span>{t("discount")}</span>
                <b>−{money(selected.discount_amount)}</b>
              </div>
              <div>
                <span>{t("tax")}</span>
                <b>{money(selected.tax_amount)}</b>
              </div>
              <div>
                <span>{t("total")}</span>
                <b>{money(selected.total)}</b>
              </div>
            </div>
            <div className="drawer-section">
              <h3>Activity history</h3>
              <div className="timeline">
                {selected.history.map((event) => (
                  <div key={event.id}>
                    <i />
                    <div>
                      <strong>{event.action.replaceAll(".", " ")}</strong>
                      <small>
                        {new Date(event.created_at).toLocaleString(language === "ar" ? "ar-EG" : "en-EG")}
                      </small>
                      {event.reason && <p>{event.reason}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <footer>
              <button
                className="soft-button"
                onClick={reprint}
                disabled={!can("pos.reprint")}
              >
                <Printer size={18} /> Reprint
              </button>
              {selected.status === "completed" && (
                <>
                  <button
                    className="soft-button"
                    onClick={() => setReversalAction("refund")}
                    disabled={!can("pos.void")}
                  >
                    <RotateCcw size={18} /> Refund
                  </button>
                  <button
                    className="danger-button"
                    onClick={() => setReversalAction("void")}
                    disabled={!can("pos.void")}
                  >
                    <ShieldAlert size={18} /> Void order
                  </button>
                </>
              )}
            </footer>
          </aside>
        </div>
      )}
      {reversalAction && (
        <div className="modal-backdrop modal-backdrop--top">
          <section className="modal compact-modal">
            <header>
              <div>
                <span className="danger-icon">
                  <ShieldAlert />
                </span>
                <div>
                  <h2>
                    {reversalAction === "refund"
                      ? "Refund transaction"
                      : "Void transaction"}
                  </h2>
                  <p>
                    {reversalAction === "refund"
                      ? "The full payment and stock will be reversed."
                      : "This action cannot be hidden or deleted."}
                  </p>
                </div>
              </div>
              <button
                className="icon-button"
                onClick={() => setReversalAction(null)}
              >
                <X />
              </button>
            </header>
            <label className="field">
              <span>Reason for {reversalAction}</span>
              <textarea
                rows={3}
                value={actionReason}
                onChange={(event) => setActionReason(event.target.value)}
                placeholder="Required for the audit log"
              />
            </label>
            <div className="modal-actions">
              <button
                className="soft-button"
                onClick={() => setReversalAction(null)}
              >
                {t("cancel")}
              </button>
              <button
                className="danger-button"
                disabled={actionReason.trim().length < 3}
                onClick={reverseOrder}
              >
                Confirm {reversalAction}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
