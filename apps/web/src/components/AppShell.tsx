import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  BarChart3,
  Boxes,
  CircleDollarSign,
  Coffee,
  LayoutDashboard,
  LogOut,
  Menu,
  ReceiptText,
  Search,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Store,
  Users,
  UsersRound,
  Wifi,
  WifiOff,
  X,
  ChevronDown,
  PanelLeftClose,
  CalendarClock,
} from "lucide-react";
import type { Permission } from "@token-taste/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { useI18n } from "../i18n";
import { Brand } from "./Brand";

const navItems: Array<{
  to: string;
  label: Parameters<ReturnType<typeof useI18n>["t"]>[0];
  icon: typeof LayoutDashboard;
  permission?: Permission;
  alternativePermission?: Permission;
}> = [
  {
    to: "/",
    label: "dashboard",
    icon: LayoutDashboard,
    permission: "reports.daily",
  },
  { to: "/pos", label: "pos", icon: Coffee, permission: "pos.access" },
  {
    to: "/orders",
    label: "orders",
    icon: ReceiptText,
    permission: "pos.history",
    alternativePermission: "sales.view",
  },
  {
    to: "/inventory",
    label: "inventory",
    icon: Boxes,
    permission: "inventory.manage",
  },
  {
    to: "/products",
    label: "products",
    icon: ShoppingBag,
    permission: "products.manage",
  },
  {
    to: "/customers",
    label: "customers",
    icon: UsersRound,
    permission: "customers.manage",
  },
  {
    to: "/treasury",
    label: "treasury",
    icon: CircleDollarSign,
    permission: "treasury.manage",
  },
  {
    to: "/reports",
    label: "reports",
    icon: BarChart3,
    permission: "reports.financial",
  },
  {
    to: "/shifts",
    label: "shifts",
    icon: CalendarClock,
    permission: "shifts.manage",
  },
  { to: "/staff", label: "staff", icon: Users, permission: "staff.manage" },
  {
    to: "/branches",
    label: "branches",
    icon: Store,
    permission: "branches.manage",
  },
  { to: "/audit", label: "audit", icon: ShieldCheck, permission: "audit.view" },
  {
    to: "/settings",
    label: "settings",
    icon: Settings,
    permission: "settings.manage",
  },
];

type SyncStatus = {
  mode: "branch" | "cloud";
  state: "synced" | "pending" | "error" | "offline";
  pending: number;
  failed: number;
};

export function AppShell() {
  const { user, can, logout } = useAuth();
  const { language, setLanguage, t, tr } = useI18n();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [globalSearch, setGlobalSearch] = useState("");
  const [apiError, setApiError] = useState("");
  const [sync, setSync] = useState<SyncStatus>({
    mode: "branch",
    state: "offline",
    pending: 0,
    failed: 0,
  });
  const location = useLocation();
  const navigate = useNavigate();
  const isPos = location.pathname === "/pos";

  useEffect(() => setMobileOpen(false), [location.pathname]);
  useEffect(() => {
    if (isPos) setSidebarCollapsed(true);
  }, [isPos]);
  useEffect(() => {
    let timeout = 0;
    const showError = (event: Event) => {
      setApiError((event as CustomEvent<string>).detail);
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => setApiError(""), 6000);
    };
    window.addEventListener("token-taste-api-error", showError);
    return () => {
      window.removeEventListener("token-taste-api-error", showError);
      window.clearTimeout(timeout);
    };
  }, []);
  useEffect(() => {
    const load = () =>
      api<SyncStatus>("/api/sync/status")
        .then(setSync)
        .catch(() =>
          setSync((previous) => ({ ...previous, state: "offline" })),
        );
    load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const title =
    navItems.find((item) => item.to === location.pathname)?.label ??
    "dashboard";

  return (
    <div className={`app-shell ${isPos ? "app-shell--pos" : ""} ${sidebarCollapsed ? "app-shell--collapsed" : ""}`}>
      <aside className={`sidebar ${mobileOpen ? "sidebar--open" : ""}`}>
        <div className="sidebar__head">
          <Brand />
          <button
            className="icon-button sidebar__mobile-close"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
          >
            <X />
          </button>
          {isPos && !sidebarCollapsed && (
            <button
              className="icon-button sidebar__pos-collapse"
              onClick={() => setSidebarCollapsed(true)}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
            >
              <PanelLeftClose size={18} />
            </button>
          )}
        </div>
        <div className="branch-chip">
          <span>
            <Store size={18} />
          </span>
          <div>
            <strong>{language === "ar" ? user?.branchNameAr : user?.branchName}</strong>
          </div>
        </div>
        <nav className="sidebar__nav">
          {navItems
            .filter((item) => !item.permission || can(item.permission) || Boolean(item.alternativePermission && can(item.alternativePermission)))
            .map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
              >
                <Icon size={20} />
                <span>{t(label)}</span>
              </NavLink>
            ))}
        </nav>
        <div className="sidebar__bottom">
          <button
            className="sidebar__link"
            onClick={() => setLanguage(language === "en" ? "ar" : "en")}
          >
            <span className="language-symbol">
              {language === "en" ? "ع" : "أ"}
            </span>
            <span>{t("language")}</span>
          </button>
          <button
            className="sidebar__link sidebar__logout"
            onClick={() => void logout()}
          >
            <LogOut size={20} />
            <span>{t("logout")}</span>
          </button>
        </div>
      </aside>
      {mobileOpen && (
        <button
          className="sidebar-scrim"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation"
        />
      )}
      <div className="app-content">
        <header className="topbar">
          <div className="topbar__title">
            <button
              className="icon-button topbar__menu"
              onClick={() => isPos ? setSidebarCollapsed((collapsed) => !collapsed) : setMobileOpen(true)}
              aria-label={isPos && !sidebarCollapsed ? "Collapse menu" : "Open menu"}
            >
              <Menu />
            </button>
            <div>
              <h1>{t(title)}</h1>
              <p>
                {language === "ar" ? user?.branchNameAr : user?.branchName}
              </p>
            </div>
          </div>
          <div className="topbar__actions">
            {can("pos.access") && <form
              className="global-search"
              onSubmit={(event) => {
                event.preventDefault();
                const query = globalSearch.trim();
                navigate(
                  query ? `/pos?q=${encodeURIComponent(query)}` : "/pos",
                );
              }}
            >
              <Search size={18} />
              <input
                value={globalSearch}
                onChange={(event) => setGlobalSearch(event.target.value)}
                placeholder={t("search")}
                aria-label={t("search")}
              />
            </form>}
            <div className={`sync-pill sync-pill--${sync.state}`}>
              {sync.state === "offline" ? (
                <WifiOff size={15} />
              ) : (
                <Wifi size={15} />
              )}
              <span>
                {sync.mode === "cloud"
                  ? t("cloudOnline")
                  : sync.state === "synced"
                  ? t("synced")
                  : sync.state === "offline"
                    ? t("offline")
                    : `${sync.pending} ${t("pending")}`}
              </span>
            </div>
            <div className="profile-menu">
            <button className="profile-chip" onClick={() => setProfileOpen((open) => !open)} aria-expanded={profileOpen}>
              <span>
                {((language === "ar" ? user?.nameAr : user?.name) ?? "")
                  .split(" ")
                  .map((name) => name[0])
                  .slice(0, 2)
                  .join("")}
              </span>
              <div>
                <strong>{user?.username}</strong>
                <small>
                  {user?.isSuperAdmin
                    ? tr("Super Admin", "المدير العام")
                    : tr("Staff", "موظف")}
                </small>
              </div>
              <ChevronDown size={16} />
            </button>
            {profileOpen && <div className="profile-menu__dropdown">
              <button onClick={() => { setLanguage(language === "en" ? "ar" : "en"); setProfileOpen(false); }}>
                <span className="language-symbol">{language === "en" ? "ع" : "أ"}</span>
                {t("language")}
              </button>
              <button className="sidebar__logout" onClick={() => void logout()}>
                <LogOut size={17} />
                {t("logout")}
              </button>
            </div>}
            </div>
          </div>
        </header>
        <main className="page">
          <Outlet />
        </main>
      </div>
      {apiError && (
        <div className="api-error-toast" role="alert">
          <strong>
            {tr("Could not complete that action", "تعذر إكمال الإجراء")}
          </strong>
          <span>{apiError}</span>
          <button onClick={() => setApiError("")} aria-label="Dismiss error">
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
