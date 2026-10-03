import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { I18nProvider } from "./i18n";
import { AppShell } from "./components/AppShell";
import { LoginPage } from "./pages/LoginPage";
import { OwnerSetupPage } from "./pages/OwnerSetupPage";
import "./styles.css";

const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const PosPage = lazy(() => import("./pages/PosPage").then((module) => ({ default: module.PosPage })));
const OrdersPage = lazy(() => import("./pages/OrdersPage").then((module) => ({ default: module.OrdersPage })));
const InventoryPage = lazy(() => import("./pages/InventoryPage").then((module) => ({ default: module.InventoryPage })));
const ProductsPage = lazy(() => import("./pages/ProductsPage").then((module) => ({ default: module.ProductsPage })));
const CustomersPage = lazy(() => import("./pages/CustomersPage").then((module) => ({ default: module.CustomersPage })));
const TreasuryPage = lazy(() => import("./pages/TreasuryPage").then((module) => ({ default: module.TreasuryPage })));
const ReportsPage = lazy(() => import("./pages/ReportsPage").then((module) => ({ default: module.ReportsPage })));
const StaffPage = lazy(() => import("./pages/StaffPage").then((module) => ({ default: module.StaffPage })));
const BranchesPage = lazy(() => import("./pages/BranchesPage").then((module) => ({ default: module.BranchesPage })));
const AuditPage = lazy(() => import("./pages/AuditPage").then((module) => ({ default: module.AuditPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const ShiftsPage = lazy(() => import("./pages/ShiftsPage").then((module) => ({ default: module.ShiftsPage })));
const ReceiptDesignsPage = lazy(() => import("./pages/ReceiptDesignsPage").then((module) => ({ default: module.ReceiptDesignsPage })));

function ProtectedRoutes() {
  const { user, loading, setupRequired, can } = useAuth();
  if (loading) return <div className="app-loader"><span /><p>Preparing Talk &amp; TASTE…</p></div>;
  if (setupRequired) return <OwnerSetupPage />;
  if (!user) return <LoginPage />;
  return (
    <Suspense fallback={<div className="route-loader"><span /></div>}><Routes>
      <Route element={<AppShell />}>
        <Route index element={can("reports.daily") ? <DashboardPage /> : <Navigate to="/pos" replace />} />
        <Route path="pos" element={can("pos.access") ? <PosPage /> : <Navigate to="/" replace />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="inventory" element={<InventoryPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="staff" element={<StaffPage />} />
        <Route path="branches" element={<BranchesPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="treasury" element={<TreasuryPage />} />
        <Route path="products" element={<ProductsPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="shifts" element={can("shifts.manage") ? <ShiftsPage /> : <Navigate to="/" replace />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="receipt-designs" element={can("settings.manage") ? <ReceiptDesignsPage /> : <Navigate to="/" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes></Suspense>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><BrowserRouter><I18nProvider><AuthProvider><ProtectedRoutes /></AuthProvider></I18nProvider></BrowserRouter></StrictMode>
);
