import { Fragment, useEffect, useMemo, useState } from "react";
import { Banknote, CalendarDays, ChevronDown, ChevronRight, Clock3, RefreshCw, Users, WalletCards } from "lucide-react";
import { formatMoney } from "@token-taste/shared";
import { api } from "../api";
import { useI18n } from "../i18n";
import { StatusBadge } from "../components/StatusBadge";

type ShiftRow = {
  id: string;
  branch_name: string;
  branch_name_ar: string;
  user_id: string;
  user_name: string;
  user_name_ar: string;
  opened_at: string;
  closed_at: string | null;
  opening_cash: number;
  closing_cash: number | null;
  expected_cash: number | null;
  difference: number | null;
  close_note: string;
  status: "open" | "closed";
  duration_minutes: number;
  orders: number;
  net_sales: number;
  cash_sales: number;
  card_sales: number;
  credit_sales: number;
  discounts: number;
  refunds: number;
  cash_movements: number;
};

type RollingUser = {
  user_id: string;
  user_name: string;
  user_name_ar: string;
  shifts: number;
  minutes: number;
  opening_cash: number;
  closing_cash: number;
  variance: number;
  orders: number;
  net_sales: number;
  cash_sales: number;
  card_sales: number;
  credit_sales: number;
};

type ShiftGroup = {
  id: string;
  user_id: string;
  user_name: string;
  user_name_ar: string;
  branch_name: string;
  branch_name_ar: string;
  status: "open" | "closed";
  opened_at: string;
  closed_at: string | null;
  duration_minutes: number;
  orders: number;
  net_sales: number;
  cash_sales: number;
  opening_cash: number;
  expected_cash: number;
  closing_cash: number | null;
  difference: number | null;
  shifts: ShiftRow[];
};

type ShiftData = {
  from: string;
  to: string;
  summary: { shifts: number; open: number; minutes: number; orders: number; netSales: number; cashSales: number; variance: number };
  shifts: ShiftRow[];
  rolling24: RollingUser[];
  filters: {
    branches: Array<{ id: string; name: string; name_ar: string }>;
    users: Array<{ id: string; name: string; name_ar: string }>;
  };
};

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
};
const duration = (minutes: number, language: string) => {
  const hours = Math.floor(minutes / 60);
  const mins = Math.max(0, Math.round(minutes % 60));
  return language === "ar" ? `${hours} س ${mins} د` : `${hours}h ${mins}m`;
};

export function ShiftsPage() {
  const { language, tr } = useI18n();
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(today());
  const [userId, setUserId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ShiftData | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const money = (value: number) => formatMoney(value, language);

  const shiftGroups = useMemo(() => {
    const grouped = new Map<string, ShiftGroup>();
    for (const shift of data?.shifts ?? []) {
      const id = `${shift.user_id}:${shift.branch_name}:${shift.status}`;
      const expected = shift.status === "open"
        ? shift.opening_cash + shift.cash_movements
        : (shift.expected_cash ?? 0);
      const current = grouped.get(id);
      if (!current) {
        grouped.set(id, {
          id,
          user_id: shift.user_id,
          user_name: shift.user_name,
          user_name_ar: shift.user_name_ar,
          branch_name: shift.branch_name,
          branch_name_ar: shift.branch_name_ar,
          status: shift.status,
          opened_at: shift.opened_at,
          closed_at: shift.closed_at,
          duration_minutes: shift.duration_minutes,
          orders: shift.orders,
          net_sales: shift.net_sales,
          cash_sales: shift.cash_sales,
          opening_cash: shift.opening_cash,
          expected_cash: expected,
          closing_cash: shift.closing_cash,
          difference: shift.difference,
          shifts: [shift],
        });
        continue;
      }
      current.opened_at = current.opened_at < shift.opened_at
        ? current.opened_at
        : shift.opened_at;
      if (shift.closed_at)
        current.closed_at = !current.closed_at || shift.closed_at > current.closed_at
          ? shift.closed_at
          : current.closed_at;
      current.duration_minutes += shift.duration_minutes;
      current.orders += shift.orders;
      current.net_sales += shift.net_sales;
      current.cash_sales += shift.cash_sales;
      current.opening_cash += shift.opening_cash;
      current.expected_cash += expected;
      if (shift.closing_cash != null)
        current.closing_cash = (current.closing_cash ?? 0) + shift.closing_cash;
      if (shift.difference != null)
        current.difference = (current.difference ?? 0) + shift.difference;
      current.shifts.push(shift);
    }
    return [...grouped.values()].sort((left, right) =>
      right.opened_at.localeCompare(left.opened_at),
    );
  }, [data?.shifts]);

  const toggleGroup = (id: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const load = async (start = from, end = to) => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ from: start, to: end });
      if (userId) query.set("userId", userId);
      if (branchId) query.set("branchId", branchId);
      if (status) query.set("status", status);
      setData(await api<ShiftData>(`/api/shifts/admin?${query}`));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const quickRange = (days: number) => {
    const start = daysAgo(days - 1);
    const end = today();
    setFrom(start);
    setTo(end);
    void load(start, end);
  };

  return (
    <div className="content-page shifts-page" aria-busy={loading}>
      <div className="page-heading">
        <div>
          <h2>{tr("Shifts", "الورديات")}</h2>
          <p>{tr("Opening, closing, worked time, sales, cash reconciliation, and employee performance.", "متابعة فتح وإغلاق الورديات وساعات العمل والمبيعات وتسوية النقد وأداء الموظفين.")}</p>
        </div>
        <button className="soft-button" onClick={() => void load()} disabled={loading}><RefreshCw size={17} /> {tr("Refresh", "تحديث")}</button>
      </div>

      <div className="report-quick-filters">
        <button onClick={() => quickRange(1)}>{tr("Today", "اليوم")}</button>
        <button onClick={() => quickRange(7)}>{tr("Last 7 days", "آخر ٧ أيام")}</button>
        <button onClick={() => quickRange(30)}>{tr("Last 30 days", "آخر ٣٠ يوماً")}</button>
      </div>

      <section className="report-filters shifts-filters">
        <CalendarDays size={18} />
        <label>{tr("From", "من")}<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>{tr("To", "إلى")}<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <label>{tr("Employee", "الموظف")}<select value={userId} onChange={(event) => setUserId(event.target.value)}><option value="">{tr("All employees", "كل الموظفين")}</option>{data?.filters.users.map((user) => <option key={user.id} value={user.id}>{language === "ar" ? user.name_ar : user.name}</option>)}</select></label>
        <label>{tr("Branch", "الفرع")}<select value={branchId} onChange={(event) => setBranchId(event.target.value)}><option value="">{tr("All branches", "كل الفروع")}</option>{data?.filters.branches.map((branch) => <option key={branch.id} value={branch.id}>{language === "ar" ? branch.name_ar : branch.name}</option>)}</select></label>
        <label>{tr("Status", "الحالة")}<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">{tr("All", "الكل")}</option><option value="open">{tr("Open", "مفتوحة")}</option><option value="closed">{tr("Closed", "مغلقة")}</option></select></label>
        <button className="primary-button" onClick={() => void load()} disabled={loading}>{tr("Apply", "تطبيق")}</button>
      </section>

      <section className="metric-grid report-metrics">
        <article className="metric-card"><div className="metric-card__icon metric-card__icon--brown"><Clock3 /></div><span>{tr("Total shifts", "إجمالي الورديات")}</span><strong>{data?.summary.shifts ?? 0}</strong><small>{data?.summary.open ?? 0} {tr("currently open", "مفتوحة حالياً")}</small></article>
        <article className="metric-card"><div className="metric-card__icon metric-card__icon--green"><Users /></div><span>{tr("Worked time", "وقت العمل")}</span><strong>{duration(data?.summary.minutes ?? 0, language)}</strong><small>{data?.summary.orders ?? 0} {tr("orders", "طلبات")}</small></article>
        <article className="metric-card"><div className="metric-card__icon metric-card__icon--blue"><WalletCards /></div><span>{tr("Net sales", "صافي المبيعات")}</span><strong>{money(data?.summary.netSales ?? 0)}</strong><small>{tr("All payment methods", "كل طرق الدفع")}</small></article>
        <article className="metric-card"><div className="metric-card__icon metric-card__icon--gold"><Banknote /></div><span>{tr("Cash handled", "النقد المتداول")}</span><strong>{money(data?.summary.cashSales ?? 0)}</strong><small>{tr("Variance", "الفارق")}: {money(data?.summary.variance ?? 0)}</small></article>
      </section>

      <section className="panel shifts-rollup">
        <header className="panel-heading"><div><h3>{tr("Past 24 hours by staff member", "آخر ٢٤ ساعة لكل موظف")}</h3><p>{tr("Multiple shifts are combined for each employee.", "يتم تجميع الورديات المتعددة لكل موظف.")}</p></div></header>
        <div className="shift-user-grid">
          {data?.rolling24.map((user) => <article key={user.user_id}>
            <header><span>{(language === "ar" ? user.user_name_ar : user.user_name).slice(0, 2)}</span><div><strong>{language === "ar" ? user.user_name_ar : user.user_name}</strong><small>{user.shifts} {tr("shifts", "ورديات")} · {duration(user.minutes, language)}</small></div></header>
            <div><span>{tr("Net sales", "صافي المبيعات")}</span><strong>{money(user.net_sales)}</strong></div>
            <div><span>{tr("Cash", "نقدي")}</span><strong>{money(user.cash_sales)}</strong></div>
            <div><span>{tr("Card / Credit", "بطاقة / آجل")}</span><strong>{money(user.card_sales + user.credit_sales)}</strong></div>
            <div><span>{tr("Orders", "الطلبات")}</span><strong>{user.orders}</strong></div>
            <footer className={user.variance === 0 ? "positive" : "negative"}>{tr("Drawer variance", "فرق الدرج")}: {money(user.variance)}</footer>
          </article>)}
          {!data?.rolling24.length && <p className="mini-empty">{tr("No shifts in the past 24 hours.", "لا توجد ورديات خلال آخر ٢٤ ساعة.")}</p>}
        </div>
      </section>

      <section className="panel shift-records">
        <header className="panel-heading"><div><h3>{tr("Shift records", "سجل الورديات")}</h3><p>{tr("Operational POS staff only — administrative accounts are excluded.", "موظفو نقاط البيع فقط — الحسابات الإدارية مستبعدة.")}</p></div></header>
        <div className="table-wrap"><table><thead><tr><th>{tr("Employee", "الموظف")}</th><th>{tr("Branch", "الفرع")}</th><th>{tr("Opened", "الفتح")}</th><th>{tr("Closed", "الإغلاق")}</th><th>{tr("Duration", "المدة")}</th><th>{tr("Orders", "الطلبات")}</th><th>{tr("Sales", "المبيعات")}</th><th>{tr("Cash", "النقد")}</th><th>{tr("Opening", "الافتتاحي")}</th><th>{tr("Expected", "المتوقع")}</th><th>{tr("Counted", "المعدود")}</th><th>{tr("Difference", "الفارق")}</th><th>{tr("Status", "الحالة")}</th></tr></thead>
          <tbody>{shiftGroups.map((group) => {
            const expandable = group.shifts.length > 1;
            const expanded = expandedGroups.has(group.id);
            const negative = group.status === "closed" && (group.difference ?? 0) < 0;
            return <Fragment key={group.id}>
              <tr className={`shift-row--grouped${negative ? " shift-row--negative" : ""}`}>
                <td><div className="shift-group-employee">{expandable ? <button type="button" onClick={() => toggleGroup(group.id)} aria-expanded={expanded} aria-label={expanded ? tr("Collapse shift details", "إخفاء تفاصيل الورديات") : tr("Expand shift details", "عرض تفاصيل الورديات")}>{expanded ? <ChevronDown /> : <ChevronRight />}</button> : <i />}<span><strong>{language === "ar" ? group.user_name_ar : group.user_name}</strong><small>{group.shifts.length} {tr(group.shifts.length === 1 ? "shift" : "shifts", group.shifts.length === 1 ? "وردية" : "ورديات")}</small></span></div></td>
                <td>{language === "ar" ? group.branch_name_ar : group.branch_name}</td>
                <td>{new Date(group.opened_at).toLocaleString(language === "ar" ? "ar-EG" : "en-GB")}</td>
                <td>{group.closed_at ? new Date(group.closed_at).toLocaleString(language === "ar" ? "ar-EG" : "en-GB") : "—"}</td>
                <td>{duration(group.duration_minutes, language)}</td><td>{group.orders}</td><td>{money(group.net_sales)}</td><td>{money(group.cash_sales)}</td><td>{money(group.opening_cash)}</td><td>{money(group.expected_cash)}</td><td>{group.closing_cash == null ? "—" : money(group.closing_cash)}</td><td className={(group.difference ?? 0) === 0 ? "positive" : "negative"}>{group.difference == null ? "—" : money(group.difference)}</td><td><StatusBadge value={group.status} /></td>
              </tr>
              {expanded && group.shifts.map((shift, index) => <tr className={`shift-row--detail${shift.status === "closed" && (shift.difference ?? 0) < 0 ? " shift-row--negative" : ""}`} key={shift.id}>
                <td><div className="shift-detail-name"><i /><span><strong>{language === "ar" ? shift.user_name_ar : shift.user_name}</strong><small>{tr(`Shift ${index + 1} of ${group.shifts.length}`, `وردية ${index + 1} من ${group.shifts.length}`)}</small></span></div></td><td>{language === "ar" ? shift.branch_name_ar : shift.branch_name}</td><td>{new Date(shift.opened_at).toLocaleString(language === "ar" ? "ar-EG" : "en-GB")}</td><td>{shift.closed_at ? new Date(shift.closed_at).toLocaleString(language === "ar" ? "ar-EG" : "en-GB") : "—"}</td><td>{duration(shift.duration_minutes, language)}</td><td>{shift.orders}</td><td>{money(shift.net_sales)}</td><td>{money(shift.cash_sales)}</td><td>{money(shift.opening_cash)}</td><td>{shift.status === "open" ? money(shift.opening_cash + shift.cash_movements) : money(shift.expected_cash ?? 0)}</td><td>{shift.closing_cash == null ? "—" : money(shift.closing_cash)}</td><td className={(shift.difference ?? 0) === 0 ? "positive" : "negative"}>{shift.difference == null ? "—" : money(shift.difference)}</td><td><StatusBadge value={shift.status} /></td>
              </tr>)}
            </Fragment>;
          })}</tbody></table></div>
      </section>
    </div>
  );
}
