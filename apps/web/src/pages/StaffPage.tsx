import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  Banknote,
  BriefcaseBusiness,
  CalendarDays,
  KeyRound,
  Pencil,
  Plus,
  Save,
  ShieldCheck,
  UserCog,
  Users,
  X,
} from "lucide-react";
import { formatMoney } from "@token-taste/shared";
import { api } from "../api";
import { useI18n } from "../i18n";
import { StatusBadge } from "../components/StatusBadge";

type StaffUser = {
  id: string;
  name: string;
  name_ar: string;
  username: string;
  phone: string;
  employment_start: string;
  monthly_salary: number;
  active: boolean;
  is_super_admin: boolean;
  role_id: string | null;
  branch_id: string;
  role_name: string;
  role_name_ar: string;
  permissions: string[];
};
type Role = {
  id: string;
  name: string;
  name_ar: string;
  description: string;
  permissions: string | null;
  system_role: number;
};
type StaffData = {
  users: StaffUser[];
  roles: Role[];
  permissions: string[];
  branches: Array<{ id: string; name: string; name_ar: string }>;
};
type Profile = {
  user: StaffUser & { branch_name: string; branch_name_ar: string };
  ledger: Array<{
    id: string;
    type: string;
    amount: number;
    note: string;
    effective_date: string;
    created_by_name: string;
    created_by_name_ar: string;
  }>;
  calculation: {
    month: string;
    salary: number;
    advances: number;
    deductions: number;
    bonuses: number;
    salaryPaid: number;
    employeeOwes: number;
    businessOwes: number;
    remainingSalary: number;
  };
  operations: {
    transactions: number;
    sales: number;
    voids: number;
    refunds: number;
    discounts: number;
    cashHandled: number;
    daysWorked: number;
    drawerOpenings: number;
  };
  recentAudit: Array<{
    id: string;
    action: string;
    created_at: string;
    reason: string | null;
    order_number: string | null;
  }>;
};

const today = new Date().toISOString().slice(0, 10);
const blankEmployee = {
  name: "",
  nameAr: "",
  username: "",
  password: "",
  roleId: "",
  branchId: "",
  phone: "",
  employmentStart: today,
  monthlySalary: 0,
};

export function StaffPage() {
  const { language, t, tr } = useI18n();
  const [data, setData] = useState<StaffData>({
    users: [],
    roles: [],
    permissions: [],
    branches: [],
  });
  const [tab, setTab] = useState<"users" | "roles">("users");
  const [employeeOpen, setEmployeeOpen] = useState(false);
  const [roleOpen, setRoleOpen] = useState(false);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [accessUser, setAccessUser] = useState<StaffUser | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [employee, setEmployee] = useState(blankEmployee);
  const [role, setRole] = useState({
    name: "",
    nameAr: "",
    description: "",
    permissions: [] as string[],
  });
  const [access, setAccess] = useState({
    roleId: "",
    permissions: [] as string[],
  });
  const [ledger, setLedger] = useState({
    type: "advance",
    amount: 0,
    note: "",
    effectiveDate: today,
  });
  const load = () => api<StaffData>("/api/staff").then(setData);
  useEffect(() => {
    void load();
  }, []);

  const toggle = (list: string[], value: string) =>
    list.includes(value)
      ? list.filter((entry) => entry !== value)
      : [...list, value];
  const createEmployee = async (event: FormEvent) => {
    event.preventDefault();
    await api("/api/staff", {
      method: "POST",
      body: JSON.stringify({
        ...employee,
        roleId: employee.roleId || null,
        monthlySalary: Math.round(employee.monthlySalary * 100),
      }),
    });
    setEmployeeOpen(false);
    setEmployee(blankEmployee);
    await load();
  };
  const createRole = async (event: FormEvent) => {
    event.preventDefault();
    await api(editingRoleId ? `/api/roles/${editingRoleId}` : "/api/roles", {
      method: editingRoleId ? "PATCH" : "POST",
      body: JSON.stringify(role),
    });
    setRoleOpen(false);
    setEditingRoleId(null);
    setRole({ name: "", nameAr: "", description: "", permissions: [] });
    await load();
  };
  const editAccess = (user: StaffUser) => {
    setAccessUser(user);
    setAccess({
      roleId: user.role_id ?? "",
      permissions: [...user.permissions],
    });
  };
  const saveAccess = async () => {
    if (!accessUser) return;
    await api(`/api/staff/${accessUser.id}/permissions`, {
      method: "PUT",
      body: JSON.stringify({
        roleId: access.roleId || null,
        overrides: Object.fromEntries(
          data.permissions.map((permission) => [
            permission,
            access.permissions.includes(permission),
          ]),
        ),
      }),
    });
    setAccessUser(null);
    await load();
  };
  const openProfile = async (user: Pick<StaffUser, "id">) =>
    setProfile(await api<Profile>(`/api/staff/${user.id}/profile`));
  const addLedger = async (event: FormEvent) => {
    event.preventDefault();
    if (!profile) return;
    await api(`/api/staff/${profile.user.id}/ledger`, {
      method: "POST",
      body: JSON.stringify({
        ...ledger,
        amount: Math.round(ledger.amount * 100),
      }),
    });
    setLedger({ type: "advance", amount: 0, note: "", effectiveDate: today });
    await openProfile(profile.user);
  };
  const saveEmployment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!profile) return;
    const values = new FormData(event.currentTarget);
    await api(`/api/staff/${profile.user.id}/employment`, {
      method: "PATCH",
      body: JSON.stringify({
        phone: values.get("phone"),
        employmentStart: values.get("employmentStart"),
        monthlySalary: Math.round(Number(values.get("monthlySalary")) * 100),
        branchId: values.get("branchId"),
      }),
    });
    await openProfile(profile.user);
    await load();
  };
  const permissionGroups = data.permissions.reduce<Record<string, string[]>>(
    (groups, permission) => {
      (groups[permission.split(".")[0] ?? "other"] ??= []).push(permission);
      return groups;
    },
    {},
  );

  return (
    <div className="content-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Access & payroll control</span>
          <h2>{t("staff")}</h2>
          <p>
            Permissions, employment records, activity, and the yellow notebook
            in one place.
          </p>
        </div>
        <button
          className="primary-button"
          onClick={() => setEmployeeOpen(true)}
        >
          <Plus size={18} /> Add employee
        </button>
      </div>
      <div className="mini-metrics">
        <article>
          <span>
            <Users />
          </span>
          <div>
            <small>Active staff</small>
            <strong>{data.users.filter((user) => user.active).length}</strong>
          </div>
        </article>
        <article>
          <span className="success">
            <ShieldCheck />
          </span>
          <div>
            <small>Permission sets</small>
            <strong>{data.roles.length}</strong>
          </div>
        </article>
        <article>
          <span className="warning">
            <KeyRound />
          </span>
          <div>
            <small>Available permissions</small>
            <strong>{data.permissions.length}</strong>
          </div>
        </article>
      </div>
      <section className="panel table-panel">
        <div className="table-toolbar">
          <div className="segmented">
            <button
              className={tab === "users" ? "active" : ""}
              onClick={() => setTab("users")}
            >
              <Users size={16} /> Employees
            </button>
            <button
              className={tab === "roles" ? "active" : ""}
              onClick={() => setTab("roles")}
            >
              <UserCog size={16} /> Roles & permissions
            </button>
          </div>
        </div>
        {tab === "users" ? (
          <StaffTable
            data={data}
            language={language}
            openProfile={openProfile}
            editAccess={editAccess}
          />
        ) : (
          <div className="role-grid">
            {data.roles.map((roleItem) => {
              const list = roleItem.permissions?.split(",") ?? [];
              return (
                <article className="role-card" key={roleItem.id}>
                  <header>
                    <span>
                      <UserCog />
                    </span>
                    <div>
                      <h3>
                        {language === "ar" ? roleItem.name_ar : roleItem.name}
                      </h3>
                      <p>{roleItem.description}</p>
                    </div>
                  </header>
                  <div className="role-permissions">
                    {list.slice(0, 8).map((permission) => (
                      <span key={permission}>
                        <i>
                          <ShieldCheck />
                        </i>
                        {permission.replaceAll(".", " · ")}
                      </span>
                    ))}
                    {list.length > 8 && (
                      <small>+{list.length - 8} more permissions</small>
                    )}
                  </div>
                  <footer>
                    <div>
                      <strong>{list.length}</strong>
                      <span> granted permissions</span>
                    </div>
                    {!roleItem.system_role && (
                      <button
                        className="icon-button"
                        onClick={() => {
                          setEditingRoleId(roleItem.id);
                          setRole({
                            name: roleItem.name,
                            nameAr: roleItem.name_ar,
                            description: roleItem.description,
                            permissions: list,
                          });
                          setRoleOpen(true);
                        }}
                        title="Edit role"
                      >
                        <Pencil size={15} />
                      </button>
                    )}
                  </footer>
                </article>
              );
            })}
            <button
              className="role-card role-card--new"
              onClick={() => {
                setEditingRoleId(null);
                setRole({
                  name: "",
                  nameAr: "",
                  description: "",
                  permissions: [],
                });
                setRoleOpen(true);
              }}
            >
              <span>
                <Plus />
              </span>
              <strong>Create a custom role</strong>
              <p>Start with no access, then assign permissions individually.</p>
            </button>
          </div>
        )}
      </section>

      {employeeOpen && (
        <div className="modal-backdrop">
          <form className="modal form-modal" onSubmit={createEmployee}>
            <ModalHeader
              icon={<Users />}
              title="Add employee"
              subtitle="Create secure branch access and an employment record."
              close={() => setEmployeeOpen(false)}
            />
            <div className="field-row">
              <Field label="English name">
                <input
                  required
                  value={employee.name}
                  onChange={(e) =>
                    setEmployee({ ...employee, name: e.target.value })
                  }
                />
              </Field>
              <Field label="الاسم بالعربية">
                <input
                  required
                  dir="rtl"
                  value={employee.nameAr}
                  onChange={(e) =>
                    setEmployee({ ...employee, nameAr: e.target.value })
                  }
                />
              </Field>
            </div>
            <div className="field-row">
              <Field label={tr("Username", "اسم المستخدم")}>
                <input
                  type="text"
                  required
                  value={employee.username}
                  onChange={(e) =>
                    setEmployee({ ...employee, username: e.target.value })
                  }
                />
              </Field>
              <Field label="Phone">
                <input
                  value={employee.phone}
                  onChange={(e) =>
                    setEmployee({ ...employee, phone: e.target.value })
                  }
                />
              </Field>
            </div>
            <div className="field-row">
              <Field label="Employment start">
                <input
                  type="date"
                  value={employee.employmentStart}
                  onChange={(e) =>
                    setEmployee({
                      ...employee,
                      employmentStart: e.target.value,
                    })
                  }
                />
              </Field>
              <Field label="Monthly salary (EGP)">
                <input
                  type="number"
                  min="0"
                  step=".01"
                  value={employee.monthlySalary || ""}
                  onChange={(e) =>
                    setEmployee({
                      ...employee,
                      monthlySalary: Number(e.target.value),
                    })
                  }
                />
              </Field>
            </div>
            <div className="field-row">
              <Field label="Branch">
                <select
                  value={employee.branchId}
                  onChange={(e) =>
                    setEmployee({ ...employee, branchId: e.target.value })
                  }
                >
                  <option value="">Current branch</option>
                  {data.branches.map((item) => (
                    <option key={item.id} value={item.id}>
                      {language === "ar" ? item.name_ar : item.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Role">
                <select
                  value={employee.roleId}
                  onChange={(e) =>
                    setEmployee({ ...employee, roleId: e.target.value })
                  }
                >
                  <option value="">No role · configure individually</option>
                  {data.roles.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Temporary password">
              <input
                type="password"
                minLength={10}
                required
                value={employee.password}
                onChange={(e) =>
                  setEmployee({ ...employee, password: e.target.value })
                }
              />
              <small>Use at least 10 characters.</small>
            </Field>
            <ModalActions
              cancel={() => setEmployeeOpen(false)}
              label="Create employee"
            />
          </form>
        </div>
      )}

      {roleOpen && (
        <div className="modal-backdrop">
          <form className="modal permission-modal" onSubmit={createRole}>
            <ModalHeader
              icon={<UserCog />}
              title={editingRoleId ? "Edit role" : "Create role"}
              subtitle="Permissions remain individually editable."
              close={() => {
                setRoleOpen(false);
                setEditingRoleId(null);
              }}
            />
            <div className="field-row">
              <Field label="Role name">
                <input
                  required
                  value={role.name}
                  onChange={(e) => setRole({ ...role, name: e.target.value })}
                />
              </Field>
              <Field label="الاسم بالعربية">
                <input
                  required
                  dir="rtl"
                  value={role.nameAr}
                  onChange={(e) => setRole({ ...role, nameAr: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Description">
              <input
                value={role.description}
                onChange={(e) =>
                  setRole({ ...role, description: e.target.value })
                }
              />
            </Field>
            <PermissionGrid
              groups={permissionGroups}
              selected={role.permissions}
              onToggle={(permission) =>
                setRole({
                  ...role,
                  permissions: toggle(role.permissions, permission),
                })
              }
            />
            <ModalActions
              cancel={() => {
                setRoleOpen(false);
                setEditingRoleId(null);
              }}
              label={editingRoleId ? "Save role" : "Create role"}
            />
          </form>
        </div>
      )}

      {accessUser && (
        <div className="modal-backdrop">
          <section className="modal permission-modal">
            <ModalHeader
              icon={<KeyRound />}
              title="Manage access"
              subtitle={`${accessUser.name} · ${access.permissions.length} permissions selected`}
              close={() => setAccessUser(null)}
            />
            <Field label="Base role">
              <select
                value={access.roleId}
                onChange={(e) =>
                  setAccess({ ...access, roleId: e.target.value })
                }
              >
                <option value="">No base role</option>
                {data.roles.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
            <PermissionGrid
              groups={permissionGroups}
              selected={access.permissions}
              onToggle={(permission) =>
                setAccess({
                  ...access,
                  permissions: toggle(access.permissions, permission),
                })
              }
            />
            <div className="modal-actions">
              <button
                className="soft-button"
                onClick={() => setAccessUser(null)}
              >
                {t("cancel")}
              </button>
              <button className="primary-button" onClick={saveAccess}>
                <Save size={17} /> Save access
              </button>
            </div>
          </section>
        </div>
      )}

      {profile && (
        <ProfileModal
          profile={profile}
          branches={data.branches}
          language={language}
          ledger={ledger}
          setLedger={setLedger}
          saveEmployment={saveEmployment}
          addLedger={addLedger}
          close={() => setProfile(null)}
        />
      )}
    </div>
  );
}

function StaffTable({
  data,
  language,
  openProfile,
  editAccess,
}: {
  data: StaffData;
  language: string;
  openProfile: (user: StaffUser) => Promise<void>;
  editAccess: (user: StaffUser) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>{language === "ar" ? "اسم المستخدم" : "Username"}</th>
            <th>Role</th>
            <th>Salary</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.users.map((user) => (
            <tr key={user.id}>
              <td>
                <div className="person-cell">
                  <span>{(language === "ar" ? user.name_ar : user.name).slice(0, 2).toUpperCase()}</span>
                  <div>
                    <strong>
                      {language === "ar" ? user.name_ar : user.name}
                    </strong>
                    <small>
                      {user.is_super_admin
                        ? "God user / Owner"
                        : `${user.permissions.length} permissions`}
                    </small>
                  </div>
                </div>
              </td>
              <td>{user.username}</td>
              <td>{language === "ar" ? user.role_name_ar ?? "مخصص" : user.role_name ?? "Custom"}</td>
              <td>
                {formatMoney(user.monthly_salary ?? 0, language as "en" | "ar")}
              </td>
              <td>
                <StatusBadge value={user.active ? "Active" : "Disabled"} />
              </td>
              <td>
                <div className="heading-actions">
                  <button
                    className="soft-button small"
                    onClick={() => void openProfile(user)}
                  >
                    Profile & ledger
                  </button>
                  <button
                    className="soft-button small"
                    disabled={user.is_super_admin}
                    onClick={() => editAccess(user)}
                  >
                    Access
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProfileModal({
  profile,
  branches,
  language,
  ledger,
  setLedger,
  saveEmployment,
  addLedger,
  close,
}: {
  profile: Profile;
  branches: StaffData["branches"];
  language: "en" | "ar";
  ledger: { type: string; amount: number; note: string; effectiveDate: string };
  setLedger: (value: {
    type: string;
    amount: number;
    note: string;
    effectiveDate: string;
  }) => void;
  saveEmployment: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  addLedger: (event: FormEvent) => Promise<void>;
  close: () => void;
}) {
  const calc = profile.calculation;
  return (
    <div className="modal-backdrop">
      <section className="modal permission-modal staff-profile">
        <ModalHeader
          icon={<BriefcaseBusiness />}
          title={language === "ar" ? profile.user.name_ar : profile.user.name}
          subtitle={language === "ar"
            ? `${profile.user.role_name_ar ?? "مخصص"} · ${profile.user.branch_name_ar}`
            : `${profile.user.role_name ?? "Custom"} · ${profile.user.branch_name}`}
          close={close}
        />
        <div className="mini-metrics">
          <article>
            <span>
              <Banknote />
            </span>
            <div>
              <small>Remaining salary</small>
              <strong>{formatMoney(calc.remainingSalary, language)}</strong>
            </div>
          </article>
          <article>
            <span className="success">
              <BriefcaseBusiness />
            </span>
            <div>
              <small>Monthly sales</small>
              <strong>{formatMoney(profile.operations.sales, language)}</strong>
            </div>
          </article>
          <article>
            <span className="warning">
              <CalendarDays />
            </span>
            <div>
              <small>Days worked</small>
              <strong>{profile.operations.daysWorked}</strong>
            </div>
          </article>
        </div>
        <form className="employment-form" onSubmit={saveEmployment}>
          <div className="field-row">
            <Field label="Phone">
              <input name="phone" defaultValue={profile.user.phone} />
            </Field>
            <Field label="Employment start">
              <input
                name="employmentStart"
                type="date"
                defaultValue={profile.user.employment_start}
              />
            </Field>
            <Field label="Monthly salary (EGP)">
              <input
                name="monthlySalary"
                type="number"
                min="0"
                step=".01"
                defaultValue={profile.user.monthly_salary / 100}
              />
            </Field>
            <Field label="Assigned branch">
              <select name="branchId" defaultValue={profile.user.branch_id}>
                {branches.map((item) => (
                  <option key={item.id} value={item.id}>
                    {language === "ar" ? item.name_ar : item.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <button className="soft-button small">
            <Save size={15} /> Save employment
          </button>
        </form>
        <section className="employee-activity-grid">
          <article>
            <span>Transactions</span>
            <strong>{profile.operations.transactions}</strong>
          </article>
          <article>
            <span>Cash handled</span>
            <strong>
              {formatMoney(profile.operations.cashHandled, language)}
            </strong>
          </article>
          <article>
            <span>Discounts given</span>
            <strong>
              {formatMoney(profile.operations.discounts, language)}
            </strong>
          </article>
          <article>
            <span>Voids / refunds</span>
            <strong>
              {profile.operations.voids} / {profile.operations.refunds}
            </strong>
          </article>
          <article>
            <span>Drawer openings</span>
            <strong>{profile.operations.drawerOpenings}</strong>
          </article>
          <article>
            <span>Audit events shown</span>
            <strong>{profile.recentAudit.length}</strong>
          </article>
        </section>
        <div className="staff-ledger-grid">
          <form className="ledger-form" onSubmit={addLedger}>
            <h3>Yellow notebook entry</h3>
            <Field label="Entry type">
              <select
                value={ledger.type}
                onChange={(e) => setLedger({ ...ledger, type: e.target.value })}
              >
                <option value="advance">Salary advance</option>
                <option value="deduction">Deduction</option>
                <option value="bonus">Bonus</option>
                <option value="salary_payment">Salary payment</option>
                <option value="employee_owes">Employee owes business</option>
                <option value="business_owes">Business owes employee</option>
                <option value="leave">Leave / absence</option>
              </select>
            </Field>
            <div className="field-row">
              <Field label="Amount (EGP)">
                <input
                  type="number"
                  min="0"
                  step=".01"
                  value={ledger.amount || ""}
                  onChange={(e) =>
                    setLedger({ ...ledger, amount: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="Effective date">
                <input
                  type="date"
                  value={ledger.effectiveDate}
                  onChange={(e) =>
                    setLedger({ ...ledger, effectiveDate: e.target.value })
                  }
                />
              </Field>
            </div>
            <Field label="Reason / note">
              <textarea
                required
                rows={2}
                value={ledger.note}
                onChange={(e) => setLedger({ ...ledger, note: e.target.value })}
              />
            </Field>
            <button className="primary-button">Add ledger entry</button>
          </form>
          <div className="ledger-summary">
            <h3>{calc.month} calculation</h3>
            <p>
              <span>Base salary</span>
              <strong>{formatMoney(calc.salary, language)}</strong>
            </p>
            <p>
              <span>Bonuses / owed</span>
              <strong>
                + {formatMoney(calc.bonuses + calc.businessOwes, language)}
              </strong>
            </p>
            <p>
              <span>Advances / deductions</span>
              <strong>
                - {formatMoney(calc.advances + calc.deductions, language)}
              </strong>
            </p>
            <p>
              <span>Paid</span>
              <strong>{formatMoney(calc.salaryPaid, language)}</strong>
            </p>
            <p className="total">
              <span>Remaining</span>
              <strong>{formatMoney(calc.remainingSalary, language)}</strong>
            </p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Note</th>
                <th>Recorded by</th>
              </tr>
            </thead>
            <tbody>
              {profile.ledger.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.effective_date}</td>
                  <td className="capitalize">
                    {entry.type.replaceAll("_", " ")}
                  </td>
                  <td>
                    <strong>{formatMoney(entry.amount, language)}</strong>
                  </td>
                  <td>{entry.note}</td>
                  <td>{language === "ar" ? entry.created_by_name_ar : entry.created_by_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="table-wrap staff-audit-table">
          <table>
            <thead>
              <tr>
                <th>Recent activity</th>
                <th>Order</th>
                <th>Time</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {profile.recentAudit.map((event) => (
                <tr key={event.id}>
                  <td className="capitalize">
                    <strong>{event.action.replaceAll(".", " ")}</strong>
                  </td>
                  <td>{event.order_number ?? "—"}</td>
                  <td>
                    {new Date(event.created_at).toLocaleString(
                      language === "ar" ? "ar-EG" : "en-EG",
                    )}
                  </td>
                  <td>{event.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function ModalHeader({
  icon,
  title,
  subtitle,
  close,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  close: () => void;
}) {
  return (
    <header>
      <div>
        <span>{icon}</span>
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>
      <button type="button" className="icon-button" onClick={close}>
        <X />
      </button>
    </header>
  );
}
function ModalActions({
  cancel,
  label,
}: {
  cancel: () => void;
  label: string;
}) {
  return (
    <div className="modal-actions">
      <button type="button" className="soft-button" onClick={cancel}>
        Cancel
      </button>
      <button className="primary-button">{label}</button>
    </div>
  );
}
function PermissionGrid({
  groups,
  selected,
  onToggle,
}: {
  groups: Partial<Record<string, string[]>>;
  selected: string[];
  onToggle: (permission: string) => void;
}) {
  return (
    <div className="permission-grid">
      {Object.entries(groups).map(([group, items]) => (
        <section key={group}>
          <h4>{group}</h4>
          {items?.map((permission) => (
            <label key={permission}>
              <input
                type="checkbox"
                checked={selected.includes(permission)}
                onChange={() => onToggle(permission)}
              />
              <i>
                <ShieldCheck />
              </i>
              <span>{permission.split(".")[1]?.replaceAll("_", " ")}</span>
            </label>
          ))}
        </section>
      ))}
    </div>
  );
}
