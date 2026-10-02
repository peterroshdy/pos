import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowDownRight,
  ArrowRight,
  Banknote,
  Boxes,
  Building2,
  CircleAlert,
  Clock3,
  Coffee,
  CreditCard,
  FileBarChart,
  PackagePlus,
  Plus,
  Receipt,
  ShoppingBag,
  TrendingUp,
  UserPlus,
  UsersRound,
  WalletCards,
} from "lucide-react";
import { formatMoney } from "@token-taste/shared";
import { api } from "../api";
import { useI18n } from "../i18n";
import { StatusBadge } from "../components/StatusBadge";

type DashboardData = {
  summary: {
    revenue: number;
    orders: number;
    average_order: number;
    voids: number;
  };
  financial: {
    previousRevenue: number;
    estimatedProfit: number;
    expensesToday: number;
    treasuryBalance: number;
  };
  operations: {
    activeShifts: number;
    activeShiftRows: Array<{
      id: string;
      opened_at: string;
      user_name: string;
      user_name_ar: string;
    }>;
    unsyncedChanges: number;
    lowStockItems: number;
    outstandingCredit: number;
  };
  payments: Array<{ payment_method: string; total: number; count: number }>;
  recentOrders: Array<{
    id: string;
    order_number: string;
    total: number;
    status: string;
    payment_method: string;
    created_at: string;
    user_name: string;
    user_name_ar: string;
  }>;
  topProducts: Array<{
    name: string;
    name_ar: string;
    quantity: number;
    revenue: number;
  }>;
  lowStock: Array<{
    id: string;
    name: string;
    name_ar: string;
    stock: number;
    low_stock_at: number;
  }>;
  chart: Array<{ date: string; revenue: number; orders: number }>;
};
type CloudOverview = {
  enabled: boolean;
  summary: {
    revenue: number;
    transactions: number;
    events?: number;
    voids?: number;
    refunds?: number;
    auditEvents?: number;
    inventoryEvents?: number;
    customerEvents?: number;
    staffEvents?: number;
    treasuryEvents?: number;
    activeShifts?: number;
    outstandingCredit?: number;
  };
  branches: Array<{
    branchId: string;
    revenue: number;
    transactions: number;
    lastSeen: string;
    voids: number;
    refunds: number;
    auditEvents: number;
    inventoryEvents: number;
    staffEvents: number;
  }>;
};

const initial: DashboardData = {
  summary: { revenue: 0, orders: 0, average_order: 0, voids: 0 },
  financial: {
    previousRevenue: 0,
    estimatedProfit: 0,
    expensesToday: 0,
    treasuryBalance: 0,
  },
  operations: {
    activeShifts: 0,
    activeShiftRows: [],
    unsyncedChanges: 0,
    lowStockItems: 0,
    outstandingCredit: 0,
  },
  payments: [],
  recentOrders: [],
  topProducts: [],
  lowStock: [],
  chart: [],
};

export function DashboardPage() {
  const { language, t, tr } = useI18n();
  const [data, setData] = useState(initial);
  const [cloud, setCloud] = useState<CloudOverview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = () =>
      Promise.all([
        api<DashboardData>("/api/dashboard").then(setData),
        api<CloudOverview>("/api/cloud/overview").then(setCloud),
      ]).finally(() => setLoading(false));
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const money = (value: number) => formatMoney(value, language);
  const paymentTotal = (method: string) =>
    data.payments.find((item) => item.payment_method === method)?.total ?? 0;
  const revenueChange = data.financial.previousRevenue
    ? Math.round(
        ((data.summary.revenue - data.financial.previousRevenue) /
          data.financial.previousRevenue) *
          100,
      )
    : null;
  const cards = [
    {
      label: t("todayRevenue"),
      value: money(data.summary.revenue),
      icon: TrendingUp,
      color: "brown",
      note:
        revenueChange === null
          ? tr("No prior-day baseline", "لا توجد مقارنة باليوم السابق")
          : `${revenueChange >= 0 ? "+" : ""}${revenueChange}% ${tr("vs yesterday", "مقارنة بالأمس")}`,
    },
    {
      label: t("ordersToday"),
      value: data.summary.orders.toLocaleString(),
      icon: Receipt,
      color: "gold",
      note: tr("Live from this branch", "مباشر من هذا الفرع"),
    },
    {
      label: tr("Cash sales", "المبيعات النقدية"),
      value: money(paymentTotal("cash")),
      icon: Banknote,
      color: "sage",
      note: tr("Completed cash transactions", "معاملات نقدية مكتملة"),
    },
    {
      label: tr("Card sales", "مبيعات البطاقات"),
      value: money(paymentTotal("card")),
      icon: CreditCard,
      color: "rose",
      note: tr("Completed card transactions", "معاملات بطاقات مكتملة"),
    },
    {
      label: tr("Credit sales", "المبيعات الآجلة"),
      value: money(paymentTotal("credit")),
      icon: WalletCards,
      color: "gold",
      note: tr("Added to customer accounts", "أضيفت إلى حسابات العملاء"),
    },
    {
      label: tr("Estimated profit", "الربح التقديري"),
      value: money(data.financial.estimatedProfit),
      icon: TrendingUp,
      color: "sage",
      note: tr("Historical item cost snapshots", "وفق تكلفة الأصناف وقت البيع"),
    },
    {
      label: tr("Expenses today", "مصروفات اليوم"),
      value: money(data.financial.expensesToday),
      icon: ArrowDownRight,
      color: "rose",
      note: tr("Recorded branch expenses", "مصروفات الفرع المسجلة"),
    },
    {
      label: tr("Treasury balance", "رصيد الخزينة"),
      value: money(data.financial.treasuryBalance),
      icon: WalletCards,
      color: "brown",
      note: tr("All recorded money movements", "جميع الحركات المالية المسجلة"),
    },
  ];

  return (
    <div className={`dashboard ${loading ? "is-loading" : ""}`}>
      <section className="welcome-banner">
        <div>
          <span className="eyebrow">
            {new Intl.DateTimeFormat(language === "ar" ? "ar-EG" : "en-EG", {
              weekday: "long",
              month: "long",
              day: "numeric",
            }).format(new Date())}
          </span>
          <h2>{tr("Management overview", "نظرة عامة على الإدارة")}</h2>
          <p>{t("overview")}</p>
        </div>
        <div className="shift-card">
          <span>
            <Clock3 size={19} />
          </span>
          <div>
            <small>
              {data.operations.activeShifts
                ? t("shiftOpen")
                : tr("No active shift", "لا توجد وردية نشطة")}
            </small>
            <strong>
              {data.operations.activeShiftRows[0]
                ? `${language === "ar" ? data.operations.activeShiftRows[0].user_name_ar : data.operations.activeShiftRows[0].user_name} · ${new Date(data.operations.activeShiftRows[0].opened_at).toLocaleTimeString(language === "ar" ? "ar-EG" : "en-EG", { hour: "2-digit", minute: "2-digit" })}`
                : tr("Open from Treasury", "افتح وردية من الخزينة")}
            </strong>
          </div>
          <i className={data.operations.activeShifts ? "" : "is-off"} />
        </div>
      </section>
      <nav className="dashboard-quick-actions">
        <span>{tr("Quick actions", "إجراءات سريعة")}</span>
        <a href="/pos">
          <Coffee /> {tr("New sale", "عملية بيع جديدة")}
        </a>
        <a href="/products">
          <PackagePlus /> {tr("Products & categories", "المنتجات والفئات")}
        </a>
        <a href="/inventory">
          <Boxes /> {tr("Add stock", "إضافة مخزون")}
        </a>
        <a href="/staff">
          <UsersRound /> {tr("Add employee", "إضافة موظف")}
        </a>
        <a href="/customers">
          <UserPlus /> {tr("Add customer", "إضافة عميل")}
        </a>
        <a href="/treasury">
          <Plus /> {tr("Expense / movement", "مصروف / حركة")}
        </a>
        <a href="/branches">
          <Building2 /> {tr("Add branch", "إضافة فرع")}
        </a>
        <a href="/reports">
          <FileBarChart /> {t("reports")}
        </a>
        <a href="/treasury">
          <WalletCards /> {t("treasury")}
        </a>
      </nav>
      <section className="metric-grid">
        {cards.map(({ label, value, icon: Icon, color, note }) => (
          <article className="metric-card" key={label}>
            <div className={`metric-card__icon metric-card__icon--${color}`}>
              <Icon size={21} />
            </div>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{note}</small>
          </article>
        ))}
      </section>
      <section className="dashboard-operations panel">
        <header>
          <div>
            <h3>{tr("Operations", "العمليات")}</h3>
            <p>
              {tr(
                "Live branch controls and exceptions",
                "متابعة الفرع والتنبيهات مباشرة",
              )}
            </p>
          </div>
        </header>
        <div>
          <article>
            <span>{tr("Active shifts", "الورديات النشطة")}</span>
            <strong>{data.operations.activeShifts}</strong>
            <small>
              {data.operations.activeShiftRows
                .map((item) => language === "ar" ? item.user_name_ar : item.user_name)
                .join(", ") ||
                tr("No employee at POS", "لا يوجد موظف على الكاشير")}
            </small>
          </article>
          <article>
            <span>{t("averageOrder")}</span>
            <strong>{money(Math.round(data.summary.average_order))}</strong>
            <small>{tr("Completed transactions", "المعاملات المكتملة")}</small>
          </article>
          <article>
            <span>{tr("Waiting to sync", "بانتظار المزامنة")}</span>
            <strong>{data.operations.unsyncedChanges}</strong>
            <small>
              {tr(
                "Local changes safely queued",
                "التغييرات المحلية محفوظة بأمان",
              )}
            </small>
          </article>
          <article>
            <span>{tr("Low-stock items", "أصناف منخفضة المخزون")}</span>
            <strong>{data.operations.lowStockItems}</strong>
            <small>
              {tr("Products and ingredients", "المنتجات والمكونات")}
            </small>
          </article>
          <article>
            <span>{tr("Customer credit", "ائتمان العملاء")}</span>
            <strong>{money(data.operations.outstandingCredit)}</strong>
            <small>{tr("Outstanding balance", "الرصيد المستحق")}</small>
          </article>
          <article>
            <span>{tr("Voided today", "ملغى اليوم")}</span>
            <strong>{data.summary.voids}</strong>
            <small>{tr("All actions audited", "جميع الإجراءات مسجلة")}</small>
          </article>
        </div>
      </section>
      {cloud?.enabled && (
        <section className="panel cloud-overview">
          <header>
            <div>
              <h3>Remote branch monitor</h3>
              <p>
                Near-real-time sales, money, stock, staff, credit, shift, and
                audit activity
              </p>
            </div>
            <strong>
              {money(cloud.summary.revenue)} · {cloud.summary.transactions}{" "}
              sales
            </strong>
          </header>
          <div className="cloud-summary-strip">
            <span>
              <b>{cloud.summary.activeShifts ?? 0}</b> active shifts
            </span>
            <span>
              <b>{cloud.summary.inventoryEvents ?? 0}</b> stock events
            </span>
            <span>
              <b>{cloud.summary.staffEvents ?? 0}</b> staff events
            </span>
            <span>
              <b>{cloud.summary.treasuryEvents ?? 0}</b> treasury events
            </span>
            <span>
              <b>{money(cloud.summary.outstandingCredit ?? 0)}</b> customer
              credit
            </span>
            <span>
              <b>{cloud.summary.auditEvents ?? 0}</b> audit events
            </span>
          </div>
          <div className="cloud-branch-grid">
            {cloud.branches.map((branch) => (
              <article key={branch.branchId}>
                <span>
                  <i /> {branch.branchId}
                </span>
                <strong>{money(branch.revenue)}</strong>
                <small>
                  {branch.transactions} sales · {branch.refunds} refunds ·{" "}
                  {branch.voids} voids
                </small>
                <small>
                  {branch.inventoryEvents} stock · {branch.staffEvents} staff ·{" "}
                  {branch.auditEvents} audit events
                </small>
                <small>
                  {tr("Windows device", "جهاز ويندوز")} · {tr("seen", "آخر اتصال")} {" "}
                  {new Date(branch.lastSeen).toLocaleTimeString(language === "ar" ? "ar-EG" : "en-EG")}
                </small>
              </article>
            ))}
          </div>
        </section>
      )}
      <section className="dashboard-grid">
        <article className="panel sales-chart-panel">
          <header>
            <div>
              <h3>{t("salesOverview")}</h3>
              <p>{t("last7Days")}</p>
            </div>
            <button className="soft-button">{t("last7Days")}</button>
          </header>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={data.chart.map((row) => ({
                  ...row,
                  revenue: row.revenue / 100,
                  label: new Intl.DateTimeFormat(
                    language === "ar" ? "ar-EG" : "en-EG",
                    { weekday: "short" },
                  ).format(new Date(`${row.date}T12:00:00`)),
                }))}
                margin={{ top: 12, right: 8, left: -20, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8b6657" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#8b6657" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  vertical={false}
                  stroke="#ede7e2"
                  strokeDasharray="4 4"
                />
                <XAxis
                  dataKey="label"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "#9b918b", fontSize: 12 }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "#9b918b", fontSize: 12 }}
                />
                <Tooltip
                  formatter={(value) => `${Number(value).toLocaleString()} EGP`}
                  contentStyle={{
                    borderRadius: 12,
                    border: "1px solid #e3dad4",
                    boxShadow: "0 10px 30px rgba(75,53,44,.1)",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  stroke="#795548"
                  strokeWidth={3}
                  fill="url(#salesFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </article>
        <article className="panel payment-panel">
          <header>
            <div>
              <h3>{t("payment")}</h3>
              <p>{tr("Today’s payment mix", "توزيع مدفوعات اليوم")}</p>
            </div>
          </header>
          <div className="payment-total">
            <span>{tr("Collected today", "المحصل اليوم")}</span>
            <strong>{money(data.summary.revenue)}</strong>
          </div>
          <div className="payment-methods">
            {[
              { key: "cash", icon: Banknote },
              { key: "card", icon: CreditCard },
              { key: "credit", icon: WalletCards },
            ].map(({ key, icon: Icon }) => {
              const payment = data.payments.find(
                (item) => item.payment_method === key,
              );
              const percentage = data.summary.revenue
                ? Math.round(
                    ((payment?.total ?? 0) / data.summary.revenue) * 100,
                  )
                : 0;
              return (
                <div className="payment-row" key={key}>
                  <span
                    className={`payment-row__icon payment-row__icon--${key}`}
                  >
                    <Icon size={18} />
                  </span>
                  <div>
                    <strong>{t(key as "cash" | "card" | "credit")}</strong>
                    <small>
                      {payment?.count ?? 0} {tr("orders", "طلبات")}
                    </small>
                  </div>
                  <span>
                    {money(payment?.total ?? 0)}
                    <small>{percentage}%</small>
                  </span>
                </div>
              );
            })}
          </div>
        </article>
        <article className="panel recent-panel">
          <header>
            <div>
              <h3>{t("recentOrders")}</h3>
              <p>
                {tr(
                  "Latest sales and order status",
                  "أحدث المبيعات وحالة الطلبات",
                )}
              </p>
            </div>
            <a href="/orders">
              {t("viewAll")} <ArrowRight size={15} />
            </a>
          </header>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("orderNumber")}</th>
                  <th>{t("user")}</th>
                  <th>{t("payment")}</th>
                  <th>{t("amount")}</th>
                  <th>{t("status")}</th>
                </tr>
              </thead>
              <tbody>
                {data.recentOrders.length ? (
                  data.recentOrders.map((order) => (
                    <tr key={order.id}>
                      <td>
                        <strong>#{order.order_number.slice(-9)}</strong>
                        <small>
                          {new Date(order.created_at).toLocaleTimeString(
                            language === "ar" ? "ar-EG" : "en-EG",
                            { hour: "2-digit", minute: "2-digit" },
                          )}
                        </small>
                      </td>
                      <td>{language === "ar" ? order.user_name_ar : order.user_name}</td>
                      <td className="capitalize">{order.payment_method}</td>
                      <td>
                        <strong>{money(order.total)}</strong>
                      </td>
                      <td>
                        <StatusBadge value={order.status} />
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="table-empty">
                      {tr("No transactions yet today", "لا توجد معاملات اليوم")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>
        <article className="panel side-list-panel">
          <header>
            <div>
              <h3>{t("topItems")}</h3>
              <p>{tr("By units sold", "حسب الوحدات المباعة")}</p>
            </div>
          </header>
          <div className="rank-list">
            {data.topProducts.length ? (
              data.topProducts.map((product, index) => (
                <div key={product.name}>
                  <span className="rank">{index + 1}</span>
                  <span className="tiny-product">
                    <Coffee size={17} />
                  </span>
                  <div>
                    <strong>
                      {language === "ar" ? product.name_ar : product.name}
                    </strong>
                    <small>
                      {product.quantity} {tr("sold", "مباع")}
                    </small>
                  </div>
                  <span>{money(product.revenue)}</span>
                </div>
              ))
            ) : (
              <div className="mini-empty">
                {tr("Sales will appear here", "ستظهر المبيعات هنا")}
              </div>
            )}
          </div>
          <div className="panel-divider" />
          <header>
            <div>
              <h3>{t("lowStock")}</h3>
              <p>{tr("Needs attention", "يحتاج إلى متابعة")}</p>
            </div>
          </header>
          <div className="stock-alert-list">
            {data.lowStock.length ? (
              data.lowStock.slice(0, 3).map((product) => (
                <div key={product.id}>
                  <span>
                    <CircleAlert size={17} />
                  </span>
                  <div>
                    <strong>
                      {language === "ar" ? product.name_ar : product.name}
                    </strong>
                    <small>
                      {product.stock} {tr("remaining", "متبقي")}
                    </small>
                  </div>
                  <b>{product.stock}</b>
                </div>
              ))
            ) : (
              <div className="mini-empty">
                {tr("Stock levels look good", "مستويات المخزون جيدة")}
              </div>
            )}
          </div>
        </article>
      </section>
    </div>
  );
}
