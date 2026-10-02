import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  Calculator,
  CreditCard,
  Plus,
  WalletCards,
  X,
} from "lucide-react";
import { formatMoney } from "@token-taste/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { useI18n } from "../i18n";

type Shift = {
  id: string;
  opened_at: string;
  opening_cash: number;
  user_name: string;
  user_name_ar: string;
};
type ShiftHistory = Shift & {
  status: string;
  closed_at: string | null;
  closing_cash: number | null;
  expected_cash: number | null;
  difference: number | null;
  sales: number;
  cash_sales: number;
  card_sales: number;
  credit_sales: number;
  discounts: number;
  transactions: number;
  voids: number;
  refunds: number;
  refund_amount: number;
  expenses: number;
  cash_added: number;
  cash_removed: number;
};
type TreasuryData = {
  movements: Array<{
    id: string;
    type: string;
    amount: number;
    payment_method: string;
    description: string;
    created_at: string;
    user_name: string;
    user_name_ar: string;
  }>;
  totals: Array<{ payment_method: string; amount: number }>;
  shift: Shift | null;
  shifts: ShiftHistory[];
};

export function TreasuryPage() {
  const { can } = useAuth();
  const { language, t } = useI18n();
  const [data, setData] = useState<TreasuryData>({
    movements: [],
    totals: [],
    shift: null,
    shifts: [],
  });
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [movementOpen, setMovementOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [expense, setExpense] = useState({
    category: "Supplies",
    description: "",
    amount: 0,
    paymentMethod: "cash",
  });
  const [movement, setMovement] = useState({
    direction: "in",
    type: "owner_deposit",
    category: "",
    description: "",
    attachment: "",
    amount: 0,
    paymentMethod: "cash",
  });
  const [closingCash, setClosingCash] = useState(0);
  const [closeNote, setCloseNote] = useState("");
  const [reconciliation, setReconciliation] = useState<{
    expected: number;
    difference: number;
  } | null>(null);
  const load = () => api<TreasuryData>("/api/treasury").then(setData);
  useEffect(() => {
    void load();
  }, []);
  const money = (value: number) => formatMoney(value, language);
  const total = data.totals.reduce((sum, item) => sum + item.amount, 0);
  const methods = [
    { key: "cash", icon: Banknote },
    { key: "card", icon: CreditCard },
    { key: "credit", icon: WalletCards },
  ];
  const createExpense = async (event: FormEvent) => {
    event.preventDefault();
    await api("/api/expenses", {
      method: "POST",
      body: JSON.stringify({
        ...expense,
        amount: Math.round(expense.amount * 100),
      }),
    });
    setExpenseOpen(false);
    setExpense({
      category: "Supplies",
      description: "",
      amount: 0,
      paymentMethod: "cash",
    });
    await load();
  };
  const createMovement = async (event: FormEvent) => {
    event.preventDefault();
    await api("/api/treasury/movements", {
      method: "POST",
      body: JSON.stringify({
        ...movement,
        amount: Math.round(movement.amount * 100),
      }),
    });
    setMovementOpen(false);
    setMovement({
      direction: "in",
      type: "owner_deposit",
      category: "",
      description: "",
      attachment: "",
      amount: 0,
      paymentMethod: "cash",
    });
    await load();
  };
  const closeShift = async () => {
    if (!data.shift) return;
    const result = await api<{ expected: number; difference: number }>(
      `/api/shifts/${data.shift.id}/close`,
      {
        method: "POST",
        body: JSON.stringify({
          closingCash: Math.round(closingCash * 100),
          note: closeNote,
        }),
      },
    );
    setReconciliation(result);
    await load();
  };
  const openShift = async () => {
    await api("/api/shifts/open", {
      method: "POST",
      body: JSON.stringify({ openingCash: 0 }),
    });
    setCloseOpen(false);
    setReconciliation(null);
    await load();
  };
  return (
    <div className="content-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Money movement</span>
          <h2>{t("treasury")}</h2>
          <p>Sales, voids, expenses, and tender totals for this branch.</p>
        </div>
        <div className="heading-actions">
          <button className="soft-button" onClick={() => setMovementOpen(true)}>
            <Plus /> Movement
          </button>
          {can("expenses.manage") && (
            <button
              className="soft-button"
              onClick={() => setExpenseOpen(true)}
            >
              <Plus /> Expense
            </button>
          )}
          {can("shifts.manage") && (
            <button
              className="primary-button"
              onClick={() => setCloseOpen(true)}
            >
              <Calculator /> {data.shift ? "Close shift" : "Open shift"}
            </button>
          )}
        </div>
      </div>
      <div className="treasury-balance">
        <div>
          <span>Net recorded movement</span>
          <strong>{money(total)}</strong>
          <small>
            {data.shift
              ? language === "ar"
                ? `فتح الوردية: ${data.shift.user_name_ar}`
                : `Shift opened by ${data.shift.user_name}`
              : "No shift is currently open"}
          </small>
        </div>
        <span>
          <WalletCards />
        </span>
      </div>
      <div className="mini-metrics">
        {methods.map(({ key, icon: Icon }) => (
          <article key={key}>
            <span>
              <Icon />
            </span>
            <div>
              <small>{t(key as "cash" | "card" | "credit")}</small>
              <strong>
                {money(
                  data.totals.find((item) => item.payment_method === key)
                    ?.amount ?? 0,
                )}
              </strong>
            </div>
          </article>
        ))}
      </div>
      <section className="panel table-panel">
        <header className="panel-title">
          <div>
            <h3>Recent movements</h3>
            <p>Recorded automatically from branch activity</p>
          </div>
        </header>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("time")}</th>
                <th>Type</th>
                <th>Description</th>
                <th>{t("payment")}</th>
                <th>{t("user")}</th>
                <th>{t("amount")}</th>
              </tr>
            </thead>
            <tbody>
              {data.movements.map((movement) => (
                <tr key={movement.id}>
                  <td>{new Date(movement.created_at).toLocaleString(language === "ar" ? "ar-EG" : "en-EG")}</td>
                  <td>
                    <span
                      className={`movement ${movement.amount >= 0 ? "movement--in" : "movement--out"}`}
                    >
                      {movement.amount >= 0 ? (
                        <ArrowUpRight />
                      ) : (
                        <ArrowDownLeft />
                      )}
                      {movement.type}
                    </span>
                  </td>
                  <td>{movement.description}</td>
                  <td className="capitalize">{movement.payment_method}</td>
                  <td>{language === "ar" ? movement.user_name_ar : movement.user_name}</td>
                  <td>
                    <strong
                      className={movement.amount < 0 ? "negative" : "positive"}
                    >
                      {movement.amount < 0 ? "−" : "+"}
                      {money(Math.abs(movement.amount))}
                    </strong>
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
            <h3>Saved shift closings</h3>
            <p>Historical drawer reconciliation and tender breakdown</p>
          </div>
        </header>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Shift</th>
                <th>Employee</th>
                <th>Cash / Card / Credit</th>
                <th>Transactions</th>
                <th>Expected</th>
                <th>Actual</th>
                <th>Difference</th>
              </tr>
            </thead>
            <tbody>
              {data.shifts.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{new Date(item.opened_at).toLocaleString(language === "ar" ? "ar-EG" : "en-EG")}</strong>
                    <small>
                      {item.status === "closed" && item.closed_at
                        ? `${language === "ar" ? "مغلق" : "Closed"} ${new Date(item.closed_at).toLocaleString(language === "ar" ? "ar-EG" : "en-EG")}`
                      : "Open"}
                    </small>
                  </td>
                  <td>{language === "ar" ? item.user_name_ar : item.user_name}</td>
                  <td>
                    {money(item.cash_sales)} / {money(item.card_sales)} /{" "}
                    {money(item.credit_sales)}
                  </td>
                  <td>
                    {item.transactions}
                    <small>
                      {item.voids} voids · {item.refunds} refunds (
                      {money(item.refund_amount)})
                    </small>
                    <small>
                      {money(item.discounts)} discounts · {money(item.expenses)}{" "}
                      expenses
                    </small>
                  </td>
                  <td>
                    {item.expected_cash === null
                      ? "—"
                      : money(item.expected_cash)}
                    <small>
                      +{money(item.cash_added)} added · −
                      {money(item.cash_removed)} removed
                    </small>
                  </td>
                  <td>
                    {item.closing_cash === null
                      ? "—"
                      : money(item.closing_cash)}
                  </td>
                  <td>
                    <strong
                      className={
                        (item.difference ?? 0) === 0 ? "positive" : "negative"
                      }
                    >
                      {item.difference === null ? "—" : money(item.difference)}
                    </strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {expenseOpen && (
        <div className="modal-backdrop">
          <form className="modal compact-modal" onSubmit={createExpense}>
            <header>
              <div>
                <span>
                  <Banknote />
                </span>
                <div>
                  <h2>Record expense</h2>
                  <p>Creates a treasury movement and audit event.</p>
                </div>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setExpenseOpen(false)}
              >
                <X />
              </button>
            </header>
            <label className="field">
              <span>Category</span>
              <select
                value={expense.category}
                onChange={(e) =>
                  setExpense({ ...expense, category: e.target.value })
                }
              >
                <option>Supplies</option>
                <option>Utilities</option>
                <option>Maintenance</option>
                <option>Transport</option>
                <option>Other</option>
              </select>
            </label>
            <label className="field">
              <span>Description</span>
              <input
                required
                value={expense.description}
                onChange={(e) =>
                  setExpense({ ...expense, description: e.target.value })
                }
              />
            </label>
            <div className="field-row">
              <label className="field">
                <span>Amount (EGP)</span>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={expense.amount || ""}
                  onChange={(e) =>
                    setExpense({ ...expense, amount: Number(e.target.value) })
                  }
                />
              </label>
              <label className="field">
                <span>Paid by</span>
                <select
                  value={expense.paymentMethod}
                  onChange={(e) =>
                    setExpense({ ...expense, paymentMethod: e.target.value })
                  }
                >
                  <option value="cash">Cash</option>
                  <option value="card">Card</option>
                </select>
              </label>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="soft-button"
                onClick={() => setExpenseOpen(false)}
              >
                {t("cancel")}
              </button>
              <button className="primary-button">Record expense</button>
            </div>
          </form>
        </div>
      )}
      {movementOpen && (
        <div className="modal-backdrop">
          <form className="modal compact-modal" onSubmit={createMovement}>
            <header>
              <div>
                <span>
                  <WalletCards />
                </span>
                <div>
                  <h2>Manual treasury movement</h2>
                  <p>
                    Owner deposits, supplier payments, withdrawals, and other
                    money.
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setMovementOpen(false)}
              >
                <X />
              </button>
            </header>
            <div className="field-row">
              <label className="field">
                <span>Direction</span>
                <select
                  value={movement.direction}
                  onChange={(e) =>
                    setMovement({ ...movement, direction: e.target.value })
                  }
                >
                  <option value="in">Money in</option>
                  <option value="out">Money out</option>
                </select>
              </label>
              <label className="field">
                <span>Type</span>
                <select
                  value={movement.type}
                  onChange={(e) =>
                    setMovement({ ...movement, type: e.target.value })
                  }
                >
                  {movement.direction === "in" ? (
                    <>
                      <option value="owner_deposit">Owner deposit</option>
                      <option value="other_income">Other income</option>
                    </>
                  ) : (
                    <>
                      <option value="supplier_payment">Supplier payment</option>
                      <option value="withdrawal">Withdrawal</option>
                      <option value="stock_purchase">Stock purchase</option>
                      <option value="miscellaneous">Miscellaneous</option>
                    </>
                  )}
                </select>
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>Category</span>
                <input
                  value={movement.category}
                  onChange={(e) =>
                    setMovement({ ...movement, category: e.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Amount (EGP)</span>
                <input
                  required
                  type="number"
                  min="0.01"
                  step=".01"
                  value={movement.amount || ""}
                  onChange={(e) =>
                    setMovement({ ...movement, amount: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <label className="field">
              <span>Notes</span>
              <textarea
                required
                rows={2}
                value={movement.description}
                onChange={(e) =>
                  setMovement({ ...movement, description: e.target.value })
                }
              />
            </label>
            <div className="field-row">
              <label className="field">
                <span>Payment method</span>
                <select
                  value={movement.paymentMethod}
                  onChange={(e) =>
                    setMovement({ ...movement, paymentMethod: e.target.value })
                  }
                >
                  <option value="cash">Cash</option>
                  <option value="card">Card</option>
                </select>
              </label>
              <label className="field">
                <span>Attachment reference · optional</span>
                <input
                  placeholder="Receipt URL or file reference"
                  value={movement.attachment}
                  onChange={(e) =>
                    setMovement({ ...movement, attachment: e.target.value })
                  }
                />
              </label>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="soft-button"
                onClick={() => setMovementOpen(false)}
              >
                {t("cancel")}
              </button>
              <button className="primary-button">Record movement</button>
            </div>
          </form>
        </div>
      )}
      {closeOpen && (
        <div className="modal-backdrop">
          <section className="modal compact-modal">
            <header>
              <div>
                <span>
                  <Calculator />
                </span>
                <div>
                  <h2>{data.shift ? "Close shift" : "Open new shift"}</h2>
                  <p>
                    {data.shift
                      ? "Count the physical cash in the drawer."
                      : "Start a shift for this branch."}
                  </p>
                </div>
              </div>
              <button
                className="icon-button"
                onClick={() => {
                  setCloseOpen(false);
                  setReconciliation(null);
                }}
              >
                <X />
              </button>
            </header>
            {data.shift && !reconciliation && (
              <>
                <label className="field">
                  <span>Counted cash (EGP)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={closingCash || ""}
                    onChange={(e) => setClosingCash(Number(e.target.value))}
                  />
                </label>
                <label className="field">
                  <span>Closing note</span>
                  <textarea
                    rows={3}
                    value={closeNote}
                    onChange={(e) => setCloseNote(e.target.value)}
                  />
                </label>
                <div className="modal-actions">
                  <button
                    className="soft-button"
                    onClick={() => setCloseOpen(false)}
                  >
                    {t("cancel")}
                  </button>
                  <button className="primary-button" onClick={closeShift}>
                    Reconcile & close
                  </button>
                </div>
              </>
            )}
            {reconciliation && (
              <div className="reconciliation">
                <div>
                  <span>Expected cash</span>
                  <strong>{money(reconciliation.expected)}</strong>
                </div>
                <div>
                  <span>Difference</span>
                  <strong
                    className={
                      reconciliation.difference === 0 ? "positive" : "negative"
                    }
                  >
                    {money(reconciliation.difference)}
                  </strong>
                </div>
                <p>
                  This result and your note are permanently recorded in the
                  audit log.
                </p>
                <button
                  className="primary-button"
                  onClick={() => {
                    setCloseOpen(false);
                    setReconciliation(null);
                  }}
                >
                  Done
                </button>
              </div>
            )}
            {!data.shift && !reconciliation && (
              <div className="reconciliation">
                <p>
                  No branch shift is open. Checkout remains unavailable until
                  a permitted employee opens one.
                </p>
                <button className="primary-button" onClick={openShift}>
                  Open shift with EGP 0
                </button>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
