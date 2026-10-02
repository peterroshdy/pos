import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Banknote,
  CalendarDays,
  Download,
  Percent,
  ReceiptText,
  TrendingUp,
} from "lucide-react";
import { formatMoney } from "@token-taste/shared";
import { api } from "../api";
import { useI18n } from "../i18n";

type ReportData = {
  source?: "cloud";
  from: string;
  to: string;
  summary: {
    revenue: number;
    orders: number;
    discounts: number;
    average_order: number;
    voids: number;
    refunds: number;
    refund_amount: number;
  };
  daily: Array<{ date: string; revenue: number; orders: number }>;
  payments: Array<{ payment_method: string; revenue: number; orders: number }>;
  products: Array<{
    name: string;
    name_ar: string;
    quantity: number;
    revenue: number;
    gross_profit: number;
  }>;
  staff: Array<{ name: string; orders: number; revenue: number }>;
  expenses: number;
  ingredients: Array<{
    name: string;
    name_ar: string;
    unit: string;
    consumed: number;
    actual_out: number;
  }>;
  categorySales: Array<{
    name: string;
    name_ar: string;
    revenue: number;
    quantity: number;
  }>;
  treasury: Array<{ type: string; amount: number; movements: number }>;
  inventoryMovements: Array<{
    type: string;
    movements: number;
    quantity: number;
  }>;
  customerPayments: { amount: number; payments: number };
  customerOutstanding: { amount: number; customers: number };
  shiftDifferences: Array<{
    id: string;
    name: string;
    closed_at: string;
    expected_cash: number;
    closing_cash: number;
    difference: number;
  }>;
  branchComparison: Array<{
    id: string;
    name: string;
    name_ar: string;
    orders: number;
    revenue: number;
  }>;
  employeeAudit: Array<{ name: string; events: number }>;
  filters: {
    branches: Array<{ id: string; name: string; name_ar: string }>;
    employees: Array<{ id: string; name: string; name_ar: string }>;
    products: Array<{ id: string; name: string; name_ar: string }>;
    categories: Array<{ id: string; name: string; name_ar: string }>;
    customers: Array<{ id: string; name: string }>;
  };
};
const blank: ReportData = {
  from: "",
  to: "",
  summary: {
    revenue: 0,
    orders: 0,
    discounts: 0,
    average_order: 0,
    voids: 0,
    refunds: 0,
    refund_amount: 0,
  },
  daily: [],
  payments: [],
  products: [],
  staff: [],
  expenses: 0,
  ingredients: [],
  categorySales: [],
  treasury: [],
  inventoryMovements: [],
  customerPayments: { amount: 0, payments: 0 },
  customerOutstanding: { amount: 0, customers: 0 },
  shiftDifferences: [],
  branchComparison: [],
  employeeAudit: [],
  filters: {
    branches: [],
    employees: [],
    products: [],
    categories: [],
    customers: [],
  },
};

export function ReportsPage() {
  const { language, t } = useI18n();
  const now = new Date();
  const [from, setFrom] = useState(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`,
  );
  const [to, setTo] = useState(now.toISOString().slice(0, 10));
  const [data, setData] = useState(blank);
  const [cloudMode, setCloudMode] = useState(false);
  const [filters, setFilters] = useState({
    branches: [] as string[],
    employeeId: "",
    paymentMethod: "",
    productId: "",
    categoryId: "",
    customerId: "",
  });
  const money = (value: number) => formatMoney(value, language);
  const reportUrl = (start = from, end = to, _cloud = cloudMode) => {
    const query = new URLSearchParams({ from: start, to: end });
    if (filters.branches.length)
      query.set("branches", filters.branches.join(","));
    Object.entries(filters).forEach(([key, value]) => {
      if (key !== "branches" && value) query.set(key, String(value));
    });
    // The operational report endpoint reads the same database used by POS
    // checkout and therefore includes both live and offline-synced history.
    // The cloud aggregation endpoint only contains received sync events and
    // can legitimately be empty before a branch uploads its outbox.
    return `/api/reports/summary?${query}`;
  };
  const load = () => api<ReportData>(reportUrl()).then(setData);
  useEffect(() => {
    void api<{ enabled: boolean }>("/api/cloud/overview")
      .then(({ enabled }) => {
        setCloudMode(enabled);
        return api<ReportData>(reportUrl(from, to, enabled));
      })
      .then(setData);
  }, []);
  const grossProfit = data.products.reduce(
    (sum, item) => sum + item.gross_profit,
    0,
  );
  const costOfGoods = data.products.reduce(
    (sum, item) => sum + item.revenue - item.gross_profit,
    0,
  );
  const contributionAfterExpenses = grossProfit - data.expenses;
  const selectPeriod = (
    period: "today" | "yesterday" | "week" | "lastWeek" | "month" | "lastMonth",
  ) => {
    const end = new Date();
    const start = new Date();
    if (period === "yesterday") {
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
    }
    if (period === "week")
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    if (period === "lastWeek") {
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 7);
      end.setTime(start.getTime());
      end.setDate(end.getDate() + 6);
    }
    if (period === "month") start.setDate(1);
    if (period === "lastMonth") {
      start.setMonth(start.getMonth() - 1, 1);
      end.setDate(0);
    }
    const iso = (date: Date) => date.toISOString().slice(0, 10);
    setFrom(iso(start));
    setTo(iso(end));
    setTimeout(
      () => api<ReportData>(reportUrl(iso(start), iso(end))).then(setData),
      0,
    );
  };
  const exportCsv = () => {
    const rows = [
      ["Product", "Units", "Revenue EGP", "Gross profit EGP"],
      ...data.products.map((item) => [
        item.name,
        item.quantity,
        (item.revenue / 100).toFixed(2),
        (item.gross_profit / 100).toFixed(2),
      ]),
    ];
    const csv = rows
      .map((row) =>
        row
          .map((value) => `"${String(value).replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    link.download = `talk-and-taste-report-${data.from}-${data.to}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <div className="content-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Financial visibility</span>
          <h2>{t("reports")}</h2>
          <p>
            {cloudMode
              ? "Synchronized multi-branch sales and operations in EGP."
              : "Sales, tender, product, and employee performance in EGP."}
          </p>
        </div>
        <button className="soft-button" onClick={exportCsv}>
          <Download size={18} /> Export CSV
        </button>
      </div>
      <div className="report-quick-filters">
        <button onClick={() => selectPeriod("today")}>Today</button>
        <button onClick={() => selectPeriod("yesterday")}>Yesterday</button>
        <button onClick={() => selectPeriod("week")}>This week</button>
        <button onClick={() => selectPeriod("lastWeek")}>Last week</button>
        <button onClick={() => selectPeriod("month")}>This month</button>
        <button onClick={() => selectPeriod("lastMonth")}>Last month</button>
      </div>
      <section className="report-dimensions">
        <label className="multi-branch-filter">
          Branch
          <details>
            <summary>
              {filters.branches.length
                ? `${filters.branches.length} selected`
                : cloudMode
                  ? "All branches"
                  : "My branch"}
            </summary>
            <div>
              <button
                type="button"
                onClick={() =>
                  setFilters({
                    ...filters,
                    branches: data.filters.branches.map((item) => item.id),
                  })
                }
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setFilters({ ...filters, branches: [] })}
              >
                {cloudMode ? "All branches" : "My branch"}
              </button>
              {data.filters.branches.map((item) => (
                <label key={item.id}>
                  <input
                    type="checkbox"
                    checked={filters.branches.includes(item.id)}
                    onChange={() =>
                      setFilters({
                        ...filters,
                        branches: filters.branches.includes(item.id)
                          ? filters.branches.filter((id) => id !== item.id)
                          : [...filters.branches, item.id],
                      })
                    }
                  />
                  <span>{language === "ar" ? item.name_ar : item.name}</span>
                </label>
              ))}
            </div>
          </details>
        </label>
        <label>
          Employee
          <select
            value={filters.employeeId}
            onChange={(e) =>
              setFilters({ ...filters, employeeId: e.target.value })
            }
          >
            <option value="">All employees</option>
            {data.filters.employees.map((item) => (
              <option key={item.id} value={item.id}>
                {language === "ar" ? item.name_ar : item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Payment
          <select
            value={filters.paymentMethod}
            onChange={(e) =>
              setFilters({ ...filters, paymentMethod: e.target.value })
            }
          >
            <option value="">All payments</option>
            <option value="cash">Cash</option>
            <option value="card">Card</option>
            <option value="credit">Credit</option>
          </select>
        </label>
        <label>
          Product
          <select
            value={filters.productId}
            onChange={(e) =>
              setFilters({ ...filters, productId: e.target.value })
            }
          >
            <option value="">All products</option>
            {data.filters.products.map((item) => (
              <option key={item.id} value={item.id}>
                {language === "ar" ? item.name_ar : item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Category
          <select
            value={filters.categoryId}
            onChange={(e) =>
              setFilters({ ...filters, categoryId: e.target.value })
            }
          >
            <option value="">All categories</option>
            {data.filters.categories.map((item) => (
              <option key={item.id} value={item.id}>
                {language === "ar" ? item.name_ar : item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Customer
          <select
            value={filters.customerId}
            onChange={(e) =>
              setFilters({ ...filters, customerId: e.target.value })
            }
          >
            <option value="">All customers</option>
            {data.filters.customers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </section>
      <section className="report-filters">
        <CalendarDays size={18} />
        <label>
          From
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button className="primary-button" onClick={load}>
          Apply custom range
        </button>
      </section>
      <section className="metric-grid report-metrics">
        <article className="metric-card">
          <div className="metric-card__icon metric-card__icon--brown">
            <TrendingUp />
          </div>
          <span>Net sales</span>
          <strong>{money(data.summary.revenue)}</strong>
          <small>Completed transactions</small>
        </article>
        <article className="metric-card">
          <div className="metric-card__icon metric-card__icon--gold">
            <ReceiptText />
          </div>
          <span>Orders</span>
          <strong>{data.summary.orders}</strong>
          <small>{money(Math.round(data.summary.average_order))} average</small>
        </article>
        <article className="metric-card">
          <div className="metric-card__icon metric-card__icon--rose">
            <Percent />
          </div>
          <span>Discounts</span>
          <strong>{money(data.summary.discounts)}</strong>
          <small>Permission-controlled</small>
        </article>
        <article className="metric-card">
          <div className="metric-card__icon metric-card__icon--sage">
            <Banknote />
          </div>
          <span>Estimated gross profit</span>
          <strong>{money(grossProfit)}</strong>
          <small>Selling price less item cost</small>
        </article>
        <article className="metric-card">
          <div className="metric-card__icon metric-card__icon--gold">
            <Banknote />
          </div>
          <span>Cost of goods</span>
          <strong>{money(costOfGoods)}</strong>
          <small>Historical cost snapshots</small>
        </article>
        <article className="metric-card">
          <div className="metric-card__icon metric-card__icon--sage">
            <TrendingUp />
          </div>
          <span>After recorded expenses</span>
          <strong>{money(contributionAfterExpenses)}</strong>
          <small>Gross profit less expenses</small>
        </article>
      </section>
      <div className="report-grid">
        <section className="panel report-chart">
          <header>
            <div>
              <h3>Revenue trend</h3>
              <p>
                {data.from} — {data.to}
              </p>
            </div>
          </header>
          <div>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={data.daily.map((d) => ({
                  ...d,
                  revenue: d.revenue / 100,
                }))}
              >
                <defs>
                  <linearGradient id="reportFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#795548" stopOpacity=".3" />
                    <stop offset="1" stopColor="#795548" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="#eee6e1" />
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: "#958a84" }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: "#958a84" }}
                />
                <Tooltip
                  formatter={(v) => `${Number(v).toLocaleString()} EGP`}
                />
                <Area
                  dataKey="revenue"
                  stroke="#795548"
                  strokeWidth={3}
                  fill="url(#reportFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="panel report-chart">
          <header>
            <div>
              <h3>Payment mix</h3>
              <p>Revenue by tender</p>
            </div>
          </header>
          <div>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data.payments.map((p) => ({
                  ...p,
                  revenue: p.revenue / 100,
                }))}
              >
                <CartesianGrid vertical={false} stroke="#eee6e1" />
                <XAxis
                  dataKey="payment_method"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: "#958a84" }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: "#958a84" }}
                />
                <Tooltip
                  formatter={(v) => `${Number(v).toLocaleString()} EGP`}
                />
                <Bar dataKey="revenue" fill="#9b7665" radius={[7, 7, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>
      <section className="panel table-panel report-table">
        <header className="panel-title">
          <div>
            <h3>Product performance</h3>
            <p>Revenue and estimated margin by product</p>
          </div>
        </header>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("product")}</th>
                <th>Units sold</th>
                <th>Revenue</th>
                <th>Gross profit</th>
                <th>Margin</th>
              </tr>
            </thead>
            <tbody>
              {data.products.map((product) => (
                <tr key={product.name}>
                  <td>
                    <strong>
                      {language === "ar" ? product.name_ar : product.name}
                    </strong>
                  </td>
                  <td>{product.quantity}</td>
                  <td>{money(product.revenue)}</td>
                  <td>
                    <strong>{money(product.gross_profit)}</strong>
                  </td>
                  <td>
                    {product.revenue
                      ? Math.round(
                          (product.gross_profit / product.revenue) * 100,
                        )
                      : 0}
                    %
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel table-panel report-table">
        <header className="panel-title">
          <div>
            <h3>Category sales</h3>
            <p>Units and revenue by menu group</p>
          </div>
        </header>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>Units sold</th>
                <th>Revenue</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {data.categorySales.map((item) => (
                <tr key={item.name}>
                  <td>
                    <strong>
                      {language === "ar" ? item.name_ar : item.name}
                    </strong>
                  </td>
                  <td>{item.quantity}</td>
                  <td>{money(item.revenue)}</td>
                  <td>
                    {data.summary.revenue
                      ? Math.round((item.revenue / data.summary.revenue) * 100)
                      : 0}
                    %
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel ingredient-report">
        <header>
          <div>
            <h3>Estimated ingredient consumption</h3>
            <p>Theoretical usage calculated from sold products and variants</p>
          </div>
        </header>
        <div>
          {data.ingredients.length ? (
            data.ingredients.map((item) => (
              <article key={item.name}>
                <span>{language === "ar" ? item.name_ar : item.name}</span>
                <strong>
                  {item.unit === "grams" && item.consumed >= 1000
                    ? `${(item.consumed / 1000).toFixed(2)} kg`
                    : `${item.consumed.toLocaleString()} ${item.unit}`}
                </strong>
                <small>
                  Estimated · recorded wastage/damage{" "}
                  {item.actual_out.toLocaleString()} {item.unit}
                </small>
              </article>
            ))
          ) : (
            <p>No recipe-linked sales in this period.</p>
          )}
        </div>
      </section>
      <section className="panel table-panel report-table">
        <header className="panel-title">
          <div>
            <h3>Employee performance</h3>
            <p>Transaction count and sales for the selected period</p>
          </div>
        </header>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Transactions</th>
                <th>Revenue</th>
                <th>Average transaction</th>
              </tr>
            </thead>
            <tbody>
              {data.staff.map((item) => (
                <tr key={item.name}>
                  <td>
                    <strong>{item.name}</strong>
                  </td>
                  <td>{item.orders}</td>
                  <td>{money(item.revenue)}</td>
                  <td>
                    {money(
                      item.orders ? Math.round(item.revenue / item.orders) : 0,
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="report-detail-grid">
        <article className="panel">
          <header>
            <div>
              <h3>Customer credit</h3>
              <p>Outstanding accounts and repayments</p>
            </div>
          </header>
          <div className="report-stat-list">
            <p>
              <span>Outstanding</span>
              <strong>{money(data.customerOutstanding.amount)}</strong>
            </p>
            <p>
              <span>Customers owing</span>
              <strong>{data.customerOutstanding.customers}</strong>
            </p>
            <p>
              <span>Payments received</span>
              <strong>{money(data.customerPayments.amount)}</strong>
            </p>
            <p>
              <span>Payment count</span>
              <strong>{data.customerPayments.payments}</strong>
            </p>
          </div>
        </article>
        <article className="panel">
          <header>
            <div>
              <h3>Operational controls</h3>
              <p>Exceptions and recorded costs</p>
            </div>
          </header>
          <div className="report-stat-list">
            <p>
              <span>Voided transactions</span>
              <strong>{data.summary.voids}</strong>
            </p>
            <p>
              <span>Refunds</span>
              <strong>
                {data.summary.refunds} · {money(data.summary.refund_amount)}
              </strong>
            </p>
            <p>
              <span>Discounts</span>
              <strong>{money(data.summary.discounts)}</strong>
            </p>
            <p>
              <span>Expenses</span>
              <strong>{money(data.expenses)}</strong>
            </p>
            <p>
              <span>Audit events</span>
              <strong>
                {data.employeeAudit.reduce((sum, item) => sum + item.events, 0)}
              </strong>
            </p>
          </div>
        </article>
      </section>
      <section className="panel table-panel report-table">
        <header className="panel-title">
          <div>
            <h3>Branch comparison</h3>
            <p>Combined or selected branch performance</p>
          </div>
        </header>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Branch</th>
                <th>Transactions</th>
                <th>Revenue</th>
                <th>Average</th>
              </tr>
            </thead>
            <tbody>
              {data.branchComparison.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>
                      {language === "ar" ? item.name_ar : item.name}
                    </strong>
                  </td>
                  <td>{item.orders}</td>
                  <td>{money(item.revenue)}</td>
                  <td>
                    {money(
                      item.orders ? Math.round(item.revenue / item.orders) : 0,
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel table-panel report-table">
        <header className="panel-title">
          <div>
            <h3>Shift closing differences</h3>
            <p>Saved shortages and excesses for the period</p>
          </div>
        </header>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Closed</th>
                <th>Employee</th>
                <th>Expected</th>
                <th>Actual</th>
                <th>Difference</th>
              </tr>
            </thead>
            <tbody>
              {data.shiftDifferences.map((item) => (
                <tr key={item.id}>
                  <td>{new Date(item.closed_at).toLocaleString(language === "ar" ? "ar-EG" : "en-EG")}</td>
                  <td>{item.name}</td>
                  <td>{money(item.expected_cash)}</td>
                  <td>{money(item.closing_cash)}</td>
                  <td>
                    <strong
                      className={
                        item.difference === 0 ? "positive" : "negative"
                      }
                    >
                      {money(item.difference)}
                    </strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="report-detail-grid">
        <article className="panel">
          <header>
            <div>
              <h3>Treasury by movement</h3>
              <p>Money in and out</p>
            </div>
          </header>
          <div className="report-stat-list">
            {data.treasury.map((item) => (
              <p key={item.type}>
                <span className="capitalize">
                  {item.type.replaceAll("_", " ")}
                </span>
                <strong>{money(item.amount)}</strong>
              </p>
            ))}
          </div>
        </article>
        <article className="panel">
          <header>
            <div>
              <h3>Inventory movements</h3>
              <p>Physical stock activity</p>
            </div>
          </header>
          <div className="report-stat-list">
            {data.inventoryMovements.map((item) => (
              <p key={item.type}>
                <span className="capitalize">
                  {item.type.replaceAll("_", " ")}
                </span>
                <strong>
                  {item.quantity} · {item.movements} events
                </strong>
              </p>
            ))}
          </div>
        </article>
      </section>
    </div>
  );
}
