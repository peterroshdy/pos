import { BarChart3, PackagePlus, Settings2 } from "lucide-react";
import { useI18n } from "../i18n";

export function PlaceholderPage({ type }: { type: "products" | "reports" | "settings" }) {
  const { t } = useI18n();
  const config = type === "products" ? { icon: PackagePlus, title: t("products"), desc: "Manage sellable items, categories, pricing, and stock behavior." }
    : type === "reports" ? { icon: BarChart3, title: t("reports"), desc: "Detailed sales, product, tender, employee, and branch performance." }
    : { icon: Settings2, title: t("settings"), desc: "Configure branch identity, tax, receipt, sync, and security preferences." };
  const Icon = config.icon;
  return <div className="content-page"><div className="page-heading"><div><span className="eyebrow">Talk &amp; TASTE management</span><h2>{config.title}</h2><p>{config.desc}</p></div></div><section className="panel feature-preview"><span><Icon/></span><h3>{config.title} workspace</h3><p>This module is connected to the same permission-aware Admin shell and will be completed on top of the current local-first data model.</p><div><i/><span>Branch-local changes</span><i/><span>Full audit trail</span><i/><span>Cloud sync ready</span></div></section></div>;
}
