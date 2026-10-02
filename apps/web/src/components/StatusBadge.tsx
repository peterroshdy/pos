import { useI18n } from "../i18n";

export function StatusBadge({ value }: { value: string }) {
  const { language } = useI18n();
  const normalized = value.toLowerCase();
  const arabic: Record<string, string> = {
    active: "نشط",
    disabled: "معطّل",
    completed: "مكتمل",
    voided: "ملغي",
    refunded: "مسترد",
    open: "مفتوح",
    closed: "مغلق",
    pending: "قيد الانتظار",
    synced: "تمت المزامنة",
    error: "خطأ",
    "low stock": "مخزون منخفض",
    "out of stock": "نفد المخزون",
    "in stock": "متوفر",
    "credit approved": "ائتمان معتمد",
    "cash only": "نقدي فقط",
    revoked: "ملغى",
    received: "مستلم",
    dispatched: "تم الإرسال",
  };
  const tone =
    normalized.includes("complete") ||
    normalized.includes("active") ||
    normalized.includes("synced") ||
    normalized === "open"
      ? "success"
      : normalized.includes("void") || normalized.includes("error")
        ? "danger"
        : normalized.includes("pending") || normalized.includes("low")
          ? "warning"
          : "neutral";
  const label =
    language === "ar"
      ? (arabic[normalized] ?? value.replaceAll("_", " "))
      : value.replaceAll("_", " ");
  return (
    <span className={`status-badge status-badge--${tone}`}>
      <i />
      {label}
    </span>
  );
}
