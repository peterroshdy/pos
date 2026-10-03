import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Banknote,
  Check,
  ChevronLeft,
  Clock3,
  Coffee,
  CreditCard,
  FileText,
  HandCoins,
  Minus,
  Pause,
  Plus,
  Printer,
  ReceiptText,
  RotateCcw,
  Search,
  ShoppingCart,
  Trash2,
  UserPlus,
  UserRound,
  WalletCards,
  X,
} from "lucide-react";
import { formatMoney, type PaymentMethod } from "@token-taste/shared";
import { QRCodeSVG } from "qrcode.react";
import { api } from "../api";
import { useAuth } from "../auth";
import { useI18n } from "../i18n";
import { EmptyState } from "../components/EmptyState";

type CategoryRow = {
  id: string;
  name: string;
  name_ar: string;
  icon: string;
  color: string;
};
type ProductRow = {
  id: string;
  category_id: string;
  sku: string;
  name: string;
  name_ar: string;
  price: number;
  stock: number;
  image: string;
  color: string;
  track_stock: boolean;
};
type VariantRow = {
  id: string;
  product_id: string;
  name: string;
  name_ar: string;
  price: number;
  cost: number;
  estimated_weight: number | null;
  estimated_weight_unit: string | null;
  stock: number;
  low_stock_at: number;
  track_stock: boolean;
};
type CartItem = ProductRow & {
  lineId: string;
  variantId: string | null;
  variantName: string | null;
  variantNameAr: string | null;
  variantTrackStock: boolean;
  variantStock: number;
  quantity: number;
  note: string;
};
type OpenShift = {
  id: string;
  user_id: string;
  user_name: string;
  user_name_ar: string;
  opened_at: string;
  opening_cash: number;
  shared_drawer: number;
};
type PosContext = {
  shift: OpenShift | null;
  openShifts: OpenShift[];
  staff: Array<{
    id: string;
    name: string;
    name_ar: string;
    username: string;
  }>;
  customers: Array<{
    id: string;
    name: string;
    phone: string;
    credit_approved: number;
    credit_limit: number;
    credit_balance: number;
  }>;
  heldOrders: Array<{
    id: string;
    total: number;
    note: string;
    created_at: string;
    cart: {
      items: Array<{
        productId: string;
        variantId?: string | null;
        quantity: number;
        note: string;
      }>;
      activityLog?: ActivityEvent[];
    };
  }>;
  branch: { name: string; name_ar: string; address: string };
  brand: { name?: string };
  barista: string;
  baristaAr: string;
  receipt: {
    footer?: string;
    autoPrint?: boolean;
    bilingual?: boolean;
    showBranch?: boolean;
    drawerTrigger?: string;
  };
};
type CompletedOrder = {
  id: string;
  orderNumber: string;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
  paymentMethod: string;
  userName?: string;
  userNameAr?: string;
  createdAt: string;
  customerBalance?: number | null;
  items: Array<{
    name: string;
    nameAr: string;
    variantName?: string | null;
    variantNameAr?: string | null;
    quantity: number;
    unitPrice: number;
    total: number;
  }>;
};
type ActivityEvent = {
  action:
    | "item.added"
    | "item.removed"
    | "item.quantity_changed"
    | "discount.changed"
    | "payment.changed"
    | "note.changed";
  productId?: string;
  originalValue?: unknown;
  newValue?: unknown;
  occurredAt: string;
};

export function PosPage() {
  const [searchParams] = useSearchParams();
  const { can } = useAuth();
  const { language, t } = useI18n();
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [variants, setVariants] = useState<VariantRow[]>([]);
  const [context, setContext] = useState<PosContext | null>(null);
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [orderNote, setOrderNote] = useState("");
  const [discount, setDiscount] = useState(0);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [customerId, setCustomerId] = useState("");
  const [cashReceived, setCashReceived] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<CompletedOrder | null>(null);
  const [mobileCart, setMobileCart] = useState(false);
  const [activityLog, setActivityLog] = useState<ActivityEvent[]>([]);
  const [heldOrderId, setHeldOrderId] = useState<string | null>(null);
  const [heldOpen, setHeldOpen] = useState(false);
  const [variantProduct, setVariantProduct] = useState<ProductRow | null>(null);
  const [openingShift, setOpeningShift] = useState(false);
  const [drawerOpening, setDrawerOpening] = useState(false);
  const [openShiftDialog, setOpenShiftDialog] = useState(false);
  const [openingCash, setOpeningCash] = useState(0);
  const [closeShiftDialog, setCloseShiftDialog] = useState(false);
  const [closingCash, setClosingCash] = useState(0);
  const [closingShift, setClosingShift] = useState(false);
  const [activeShiftId, setActiveShiftId] = useState(
    () => localStorage.getItem("talk-taste-active-shift") ?? "",
  );
  const [joinShiftDialog, setJoinShiftDialog] = useState(false);
  const [joiningUserId, setJoiningUserId] = useState("");
  const [joiningPassword, setJoiningPassword] = useState("");
  const [joiningShift, setJoiningShift] = useState(false);
  const [joinError, setJoinError] = useState("");

  const load = async () => {
    const [catalog, posContext] = await Promise.all([
      api<{
        categories: CategoryRow[];
        products: ProductRow[];
        variants: VariantRow[];
      }>("/api/catalog"),
      api<PosContext>("/api/pos/context"),
    ]);
    setCategories(catalog.categories);
    setProducts(catalog.products);
    setVariants(catalog.variants);
    setContext(posContext);
  };
  useEffect(() => {
    void load();
  }, []);
  const activeShift = useMemo(
    () =>
      context?.openShifts.find((shift) => shift.id === activeShiftId) ??
      context?.shift ??
      null,
    [context, activeShiftId],
  );
  useEffect(() => {
    if (!context) return;
    if (activeShift) {
      localStorage.setItem("talk-taste-active-shift", activeShift.id);
      if (activeShift.id !== activeShiftId) setActiveShiftId(activeShift.id);
    } else {
      localStorage.removeItem("talk-taste-active-shift");
      if (activeShiftId) setActiveShiftId("");
    }
  }, [context, activeShift, activeShiftId]);
  useEffect(() => {
    if (receipt && context?.receipt.autoPrint) {
      const timer = window.setTimeout(() => window.print(), 250);
      return () => window.clearTimeout(timer);
    }
  }, [receipt, context?.receipt.autoPrint]);

  const filteredProducts = useMemo(
    () =>
      products.filter((product) => {
        const matchesCategory =
          category === "all" || product.category_id === category;
        const term = search.toLowerCase().trim();
        return (
          matchesCategory &&
          (!term ||
            product.name.toLowerCase().includes(term) ||
            product.name_ar.includes(term) ||
            product.sku.toLowerCase().includes(term))
        );
      }),
    [products, category, search],
  );
  const subtotal = cart.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  );
  const total = Math.max(0, subtotal - discount);
  const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const money = (value: number) => formatMoney(value, language);
  const receiptMoney = (value: number) => formatMoney(value, "en");

  const add = (product: ProductRow, variant?: VariantRow) => {
    const lineId = `${product.id}:${variant?.id ?? "base"}`;
    const totalProductQuantity = cart
      .filter((item) => item.id === product.id)
      .reduce((sum, item) => sum + item.quantity, 0);
    const lineQuantity =
      cart.find((item) => item.lineId === lineId)?.quantity ?? 0;
    if (variant?.track_stock && variant.stock <= lineQuantity) return;
    if (
      !variant?.track_stock &&
      product.track_stock &&
      product.stock <= totalProductQuantity
    )
      return;
    setCart((current) =>
      current.some((item) => item.lineId === lineId)
        ? current.map((item) =>
            item.lineId === lineId
              ? { ...item, quantity: item.quantity + 1 }
              : item,
          )
        : [
            ...current,
            {
              ...product,
              lineId,
              variantId: variant?.id ?? null,
              variantName: variant?.name ?? null,
              variantNameAr: variant?.name_ar ?? null,
              variantTrackStock: variant?.track_stock ?? false,
              variantStock: variant?.stock ?? 0,
              price: variant?.price ?? product.price,
              quantity: 1,
              note: "",
            },
          ],
    );
    const previous = cart.find((item) => item.lineId === lineId)?.quantity ?? 0;
    setActivityLog((events) => [
      ...events,
      {
        action: "item.added",
        productId: product.id,
        originalValue: { quantity: previous },
        newValue: { quantity: previous + 1 },
        occurredAt: new Date().toISOString(),
      },
    ]);
    setVariantProduct(null);
  };
  const chooseProduct = (product: ProductRow) => {
    if (!activeShift) {
      setError(language === "ar" ? "افتح درج النقدية أولاً لبدء الوردية." : "Open the cash register first to start the shift.");
      return;
    }
    const options = variants.filter(
      (variant) => variant.product_id === product.id,
    );
    if (options.length) setVariantProduct(product);
    else add(product);
  };
  const changeQuantity = (lineId: string, delta: number) => {
    const item = cart.find((entry) => entry.lineId === lineId);
    if (!item) return;
    const stockLimit = item.variantTrackStock
      ? item.variantStock
      : item.track_stock
        ? item.stock
        : Number.POSITIVE_INFINITY;
    const quantity = Math.min(stockLimit, item.quantity + delta);
    setCart((current) =>
      current.flatMap((entry) =>
        entry.lineId !== lineId
          ? [entry]
          : quantity > 0
            ? [{ ...entry, quantity }]
            : [],
      ),
    );
    setActivityLog((events) => [
      ...events,
      {
        action: quantity > 0 ? "item.quantity_changed" : "item.removed",
        productId: item.id,
        originalValue: { quantity: item.quantity, variantId: item.variantId },
        newValue: {
          quantity: Math.max(0, quantity),
          variantId: item.variantId,
        },
        occurredAt: new Date().toISOString(),
      },
    ]);
  };
  const removeItem = (lineId: string) => {
    const item = cart.find((entry) => entry.lineId === lineId);
    setCart((current) => current.filter((entry) => entry.lineId !== lineId));
    if (item)
      setActivityLog((events) => [
        ...events,
        {
          action: "item.removed",
          productId: item.id,
          originalValue: { quantity: item.quantity, variantId: item.variantId },
          newValue: { quantity: 0 },
          occurredAt: new Date().toISOString(),
        },
      ]);
  };
  const clearOrder = () => {
    setCart([]);
    setOrderNote("");
    setDiscount(0);
    setActivityLog([]);
    setHeldOrderId(null);
    setPaymentMethod("cash");
    setCustomerId("");
    setCashReceived(0);
    setMobileCart(false);
  };
  const applyDiscount = () => {
    const next = discount ? 0 : Math.round(subtotal * 0.1);
    setActivityLog((events) => [
      ...events,
      {
        action: "discount.changed",
        originalValue: { discountAmount: discount },
        newValue: { discountAmount: next },
        occurredAt: new Date().toISOString(),
      },
    ]);
    setDiscount(next);
  };
  const changePayment = (next: PaymentMethod) => {
    if (next !== paymentMethod)
      setActivityLog((events) => [
        ...events,
        {
          action: "payment.changed",
          originalValue: { paymentMethod },
          newValue: { paymentMethod: next },
          occurredAt: new Date().toISOString(),
        },
      ]);
    setPaymentMethod(next);
  };

  const holdOrder = async () => {
    if (!activeShift || !cart.length) return;
    await api("/api/orders/hold", {
      method: "POST",
      body: JSON.stringify({
        shiftId: activeShift.id,
        note: orderNote,
        activityLog,
        items: cart.map((item) => ({
          productId: item.id,
          variantId: item.variantId,
          quantity: item.quantity,
          note: item.note,
        })),
      }),
    });
    clearOrder();
    await load();
  };
  const openShift = async () => {
    setOpeningShift(true);
    setError("");
    try {
      const opened = await api<{ id: string }>("/api/shifts/open", {
        method: "POST",
        body: JSON.stringify({ openingCash }),
      });
      setActiveShiftId(opened.id);
      await load();
      setOpenShiftDialog(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open the cash register");
    } finally {
      setOpeningShift(false);
    }
  };
  const showJoinShift = () => {
    const available = context?.staff.find(
      (employee) =>
        !context.openShifts.some((shift) => shift.user_id === employee.id),
    );
    setJoiningUserId(available?.id ?? context?.staff[0]?.id ?? "");
    setJoiningPassword("");
    setJoinError("");
    setJoinShiftDialog(true);
  };
  const joinShift = async () => {
    if (!joiningUserId || !joiningPassword) return;
    setJoiningShift(true);
    setJoinError("");
    try {
      const response = await api<{ shift: OpenShift }>("/api/shifts/join", {
        method: "POST",
        body: JSON.stringify({
          userId: joiningUserId,
          password: joiningPassword,
        }),
      });
      setActiveShiftId(response.shift.id);
      setJoiningPassword("");
      setJoinShiftDialog(false);
      await load();
    } catch (caught) {
      setJoinError(
        caught instanceof Error ? caught.message : "Could not join this POS",
      );
    } finally {
      setJoiningShift(false);
    }
  };
  const removeHeld = async (id: string) => {
    await api(`/api/orders/held/${id}`, { method: "DELETE" });
    await load();
  };
  const openDrawer = async () => {
    if (!activeShift) return;
    setDrawerOpening(true);
    setError("");
    try {
      await api("/api/pos/cash-drawer", {
        method: "POST",
        body: JSON.stringify({ shiftId: activeShift.id, reason: "Barista requested drawer opening" }),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The cash drawer could not be opened");
    } finally {
      setDrawerOpening(false);
    }
  };
  const closeShift = async () => {
    if (!activeShift) return;
    if (cart.length) {
      setError(language === "ar" ? "أكمل الطلب الحالي قبل إغلاق الوردية." : "Complete or clear the current order before closing the shift.");
      return;
    }
    setClosingShift(true);
    setError("");
    try {
      await api(`/api/shifts/${activeShift.id}/close`, {
        method: "POST",
        body: JSON.stringify(
          activeShift.shared_drawer ? {} : { closingCash },
        ),
      });
      setCloseShiftDialog(false);
      setActiveShiftId("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The shift could not be closed");
    } finally {
      setClosingShift(false);
    }
  };
  const resumeHeld = (held: PosContext["heldOrders"][number]) => {
    const resumed = held.cart.items.flatMap((item) => {
      const product = products.find((entry) => entry.id === item.productId);
      const variant = item.variantId
        ? variants.find((option) => option.id === item.variantId)
        : undefined;
      return product
        ? [
            {
              ...product,
              lineId: `${product.id}:${variant?.id ?? "base"}`,
              variantId: variant?.id ?? null,
              variantName: variant?.name ?? null,
              variantNameAr: variant?.name_ar ?? null,
              variantTrackStock: variant?.track_stock ?? false,
              variantStock: variant?.stock ?? 0,
              price: variant?.price ?? product.price,
              quantity: item.quantity,
              note: item.note,
            },
          ]
        : [];
    });
    setCart(resumed);
    setOrderNote(held.note);
    setActivityLog(held.cart.activityLog ?? []);
    setHeldOrderId(held.id);
    setHeldOpen(false);
  };

  const checkout = async () => {
    if (!activeShift || !cart.length) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await api<{ order: CompletedOrder }>(
        "/api/orders/checkout",
        {
          method: "POST",
          body: JSON.stringify({
            clientRequestId: crypto.randomUUID(),
            shiftId: activeShift.id,
            customerId: paymentMethod === "credit" ? customerId || null : null,
            paymentMethod,
            discountAmount: discount,
            note: orderNote,
            heldOrderId,
            activityLog,
            items: cart.map((item) => ({
              productId: item.id,
              variantId: item.variantId,
              quantity: item.quantity,
              unitPrice: item.price,
              note: item.note,
            })),
          }),
        },
      );
      setReceipt(response.order);
      setCheckoutOpen(false);
      clearOrder();
      if (
        paymentMethod === "cash" &&
        context?.receipt.drawerTrigger !== "disabled" &&
        can("pos.drawer")
      ) {
        try {
          await api("/api/pos/cash-drawer", {
            method: "POST",
            body: JSON.stringify({
              orderId: response.order.id,
              reason: `Cash checkout ${response.order.orderNumber}`,
            }),
          });
        } catch {
          // The order is already completed. A hardware/permission problem
          // must never make the cashier repeat the sale.
          setError(
            language === "ar"
              ? "تم حفظ الطلب، لكن تعذر فتح درج النقدية."
              : "Order completed, but the cash drawer could not be opened.",
          );
        }
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Checkout failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="pos-page">
      <section className="pos-catalog">
        <div className="pos-toolbar">
          <label className="pos-search">
            <Search size={20} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("search")}
            />
            {search && (
              <button onClick={() => setSearch("")}>
                <X size={17} />
              </button>
            )}
          </label>
          <button
            className="soft-button pos-recent"
            onClick={() => setHeldOpen(true)}
          >
            <Clock3 size={18} />
            {context?.heldOrders?.length
              ? `${context.heldOrders.length} ${t("hold")}`
            : t("recent")}
          </button>
        </div>
        <div className="category-tabs">
          <button
            className={category === "all" ? "active" : ""}
            onClick={() => setCategory("all")}
          >
            <span className="category-icon">✦</span>
            <strong>{t("all")}</strong>
            <small>{products.length}</small>
          </button>
          {categories.map((item) => (
            <button
              key={item.id}
              className={category === item.id ? "active" : ""}
              onClick={() => setCategory(item.id)}
            >
              <span
                className="category-icon"
                style={{ background: `${item.color}20`, color: item.color }}
              >
                <Coffee size={18} />
              </span>
              <strong>{language === "ar" ? item.name_ar : item.name}</strong>
              <small>
                {
                  products.filter((product) => product.category_id === item.id)
                    .length
                }
              </small>
            </button>
          ))}
        </div>
        <div className="catalog-heading">
          <div>
            <h2>
              {category === "all"
                ? t("all")
                : language === "ar"
                  ? categories.find((item) => item.id === category)?.name_ar
                  : categories.find((item) => item.id === category)?.name}
            </h2>
            <p>{filteredProducts.length} products available</p>
          </div>
          {activeShift ? <span className="shift-status-actions"><span>{language === "ar" ? activeShift.user_name_ar : activeShift.user_name} <i /></span><button className="soft-button" onClick={() => setCloseShiftDialog(true)}>{language === "ar" ? "إنهاء الوردية" : "End shift"}</button></span> : (
            <button className="soft-button" onClick={() => setOpenShiftDialog(true)} disabled={openingShift}>
              <Banknote size={16} />
              {openingShift ? (language === "ar" ? "جارٍ الفتح…" : "Opening…") : (language === "ar" ? "فتح درج النقدية" : "Open cash register")}
            </button>
          )}
        </div>
        {context && context.openShifts.length > 0 && (
          <div className="pos-on-duty" aria-label={language === "ar" ? "الموظفون في الوردية" : "Staff on duty"}>
            <span>{language === "ar" ? "في الوردية" : "On duty"}</span>
            <div>
              {context.openShifts.map((shift) => (
                <button
                  key={shift.id}
                  className={shift.id === activeShift?.id ? "is-active" : ""}
                  onClick={() => setActiveShiftId(shift.id)}
                  title={language === "ar" ? "اختيار منفذ الطلب" : "Select order operator"}
                >
                  <UserRound size={14} />
                  <strong>{language === "ar" ? shift.user_name_ar : shift.user_name}</strong>
                  <small>{new Date(shift.opened_at).toLocaleTimeString(language === "ar" ? "ar-EG" : "en-EG", { hour: "numeric", minute: "2-digit" })}</small>
                </button>
              ))}
              <button className="pos-join-shift" onClick={showJoinShift}>
                <UserPlus size={15} />
                <strong>{language === "ar" ? "انضمام موظف" : "Join employee"}</strong>
              </button>
            </div>
          </div>
        )}
        {!activeShift && (
          <div className="pos-shift-required" role="alert">
            <Banknote size={18} />
            <strong>{language === "ar" ? "افتح درج النقدية قبل تسجيل أي طلب" : "Open the cash register before taking orders"}</strong>
          </div>
        )}
        <div className="product-grid">
          {filteredProducts.map((product) => {
            const inCart = cart
              .filter((item) => item.id === product.id)
              .reduce((sum, item) => sum + item.quantity, 0);
            const soldOut = product.track_stock && product.stock <= 0;
            return (
              <button
                className={`product-card ${inCart ? "product-card--selected" : ""}`}
                key={product.id}
                onClick={() => chooseProduct(product)}
                disabled={soldOut || !activeShift}
              >
                <div
                  className="product-card__visual"
                  style={{
                    background: `linear-gradient(145deg, ${product.color}, #fbf7f3)`,
                  }}
                >
                  <span>{product.image || "☕"}</span>
                  {inCart > 0 && <b>{inCart}</b>}
                  {product.stock <= 10 && !soldOut && (
                    <i>Only {product.stock}</i>
                  )}
                  {soldOut && <i>Sold out</i>}
                </div>
                <div className="product-card__body">
                  <small>
                    {
                      categories.find(
                        (item) => item.id === product.category_id,
                      )?.[language === "ar" ? "name_ar" : "name"]
                    }
                  </small>
                  <strong>
                    {language === "ar" ? product.name_ar : product.name}
                  </strong>
                  <div>
                    <b>{money(product.price)}</b>
                    <span className="add-circle">
                      {inCart ? <Check size={16} /> : <Plus size={16} />}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
          {!filteredProducts.length && (
            <div className="catalog-empty">
              <EmptyState
                icon={Search}
                title={t("noResults")}
                description="Try another search or category"
              />
            </div>
          )}
        </div>
      </section>
      <aside
        className={`order-panel ${mobileCart ? "order-panel--mobile-open" : ""}`}
      >
        <header className="order-panel__header">
          <div>
            <span>
              <ShoppingCart size={20} />
            </span>
            <div>
              <h2>{t("currentOrder")}</h2>
              <p>
                {itemCount} {itemCount === 1 ? "item" : "items"}
              </p>
            </div>
          </div>
          {activeShift && can("pos.drawer") && (
            <button className="soft-button drawer-button" onClick={() => void openDrawer()} disabled={drawerOpening}>
              <Banknote size={17} />
              {drawerOpening ? (language === "ar" ? "جارٍ الفتح…" : "Opening…") : (language === "ar" ? "فتح درج النقدية" : "Open cash drawer")}
            </button>
          )}
          <button
            className="icon-button cart-mobile-close"
            onClick={() => setMobileCart(false)}
          >
            <X />
          </button>
        </header>
        <div className="order-items">
          {cart.length ? (
            cart.map((item) => (
              <article className="order-item" key={item.lineId}>
                <div
                  className="order-item__visual"
                  style={{ background: item.color }}
                >
                  {item.image}
                </div>
                <div className="order-item__info">
                  <div>
                    <strong>
                      {language === "ar" ? item.name_ar : item.name}
                    </strong>
                    <button onClick={() => removeItem(item.lineId)}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <small>
                    {item.variantId
                      ? `${language === "ar" ? item.variantNameAr : item.variantName} · `
                      : ""}
                    {money(item.price)} each
                  </small>
                  <div className="quantity-control">
                    <button onClick={() => changeQuantity(item.lineId, -1)}>
                      {item.quantity === 1 ? (
                        <Trash2 size={14} />
                      ) : (
                        <Minus size={15} />
                      )}
                    </button>
                    <b>{item.quantity}</b>
                    <button onClick={() => changeQuantity(item.lineId, 1)}>
                      <Plus size={15} />
                    </button>
                    <strong>{money(item.price * item.quantity)}</strong>
                  </div>
                </div>
              </article>
            ))
          ) : (
            <EmptyState
              icon={ShoppingCart}
              title={t("emptyCart")}
              description={t("emptyCartHint")}
            />
          )}
        </div>
        {cart.length > 0 && (
          <div className="order-note">
            <FileText size={17} />
            <input
              value={orderNote}
              onChange={(event) => setOrderNote(event.target.value)}
              placeholder={t("note")}
            />
          </div>
        )}
        <div className="order-summary">
          <div>
            <span>{t("subtotal")}</span>
            <strong>{money(subtotal)}</strong>
          </div>
          <div className={discount ? "discount-row" : ""}>
            <span>
              {t("discount")}{" "}
              {can("pos.discount") && (
                <button onClick={applyDiscount}>
                  {discount ? "Remove" : "+ Add"}
                </button>
              )}
            </span>
            <strong>{discount ? `−${money(discount)}` : money(0)}</strong>
          </div>
          <div>
            <span>
              {t("tax")} <small>Disabled</small>
            </span>
            <strong>{money(0)}</strong>
          </div>
          <div className="order-total">
            <span>{t("total")}</span>
            <strong>{money(total)}</strong>
          </div>
        </div>
        <div className="order-actions">
          <button
            className="checkout-button"
            disabled={!cart.length || !activeShift}
            onClick={() => {
              setCheckoutOpen(true);
              setCashReceived(total);
            }}
          >
            {t("checkout")}
            <span>{money(total)}</span>
          </button>
          <div>
            <button disabled={!cart.length} onClick={holdOrder}>
              <Pause size={18} />
              {t("hold")}
            </button>
            <button disabled={!cart.length} onClick={clearOrder}>
              <RotateCcw size={18} />
              {t("clear")}
            </button>
          </div>
        </div>
      </aside>
      <button
        className="mobile-cart-button"
        onClick={() => setMobileCart(true)}
      >
        <ShoppingCart size={21} />
        <span>{itemCount}</span>
        <b>{money(total)}</b>
      </button>

      {checkoutOpen && (
        <div className="modal-backdrop">
          <section className="modal checkout-modal">
            <header>
              <div>
                <span>
                  <HandCoins size={23} />
                </span>
                <div>
                  <h2>{t("pay")}</h2>
                  <p>Choose a payment method</p>
                </div>
              </div>
              <button
                className="icon-button"
                onClick={() => setCheckoutOpen(false)}
              >
                <X />
              </button>
            </header>
            <div className="checkout-total">
              <span>{t("total")}</span>
              <strong>{money(total)}</strong>
              <small>{itemCount} items in this order</small>
            </div>
            <div className="payment-choice">
              {[
                { key: "cash", icon: Banknote },
                { key: "card", icon: CreditCard },
                { key: "credit", icon: WalletCards },
              ].map(({ key, icon: Icon }) => (
                <button
                  key={key}
                  className={paymentMethod === key ? "active" : ""}
                  onClick={() => changePayment(key as PaymentMethod)}
                >
                  <span>
                    <Icon />
                  </span>
                  <strong>{t(key as "cash" | "card" | "credit")}</strong>
                  {paymentMethod === key && (
                    <i>
                      <Check size={13} />
                    </i>
                  )}
                </button>
              ))}
            </div>
            {paymentMethod === "cash" && (
              <div className="cash-input">
                <label>
                  Cash received
                  <div>
                    <span>EGP</span>
                    <input
                      type="number"
                      value={cashReceived / 100 || ""}
                      onChange={(event) =>
                        setCashReceived(
                          Math.round(Number(event.target.value) * 100),
                        )
                      }
                    />
                  </div>
                </label>
                <div>
                  <span>Change due</span>
                  <strong>{money(Math.max(0, cashReceived - total))}</strong>
                </div>
              </div>
            )}
            {paymentMethod === "card" && (
              <div className="payment-message">
                <CreditCard />
                <div>
                  <strong>Use the card terminal</strong>
                  <p>Confirm the terminal payment, then complete this sale.</p>
                </div>
              </div>
            )}
            {paymentMethod === "credit" && (
              <label className="customer-select">
                <span>{t("customer")}</span>
                <div>
                  <UserRound size={18} />
                  <select
                    value={customerId}
                    onChange={(event) => setCustomerId(event.target.value)}
                  >
                    <option value="">Select an approved customer</option>
                    {context?.customers
                      .filter((customer) => customer.credit_approved)
                      .map((customer) => (
                        <option key={customer.id} value={customer.id}>
                          {customer.name} ·{" "}
                          {money(
                            customer.credit_limit - customer.credit_balance,
                          )}{" "}
                          available
                        </option>
                      ))}
                  </select>
                </div>
              </label>
            )}
            {error && <div className="form-error">{error}</div>}
            <button
              className="primary-button checkout-confirm"
              onClick={checkout}
              disabled={
                submitting ||
                (paymentMethod === "cash" && cashReceived < total) ||
                (paymentMethod === "credit" && !customerId)
              }
            >
              {submitting ? "Processing…" : t("checkout")}
              <ChevronLeft className="rtl-flip" size={20} />
            </button>
          </section>
        </div>
      )}

      {openShiftDialog && (
        <div className="modal-backdrop">
          <section className="modal compact-modal">
            <header>
              <div>
                <span><Banknote size={22} /></span>
                <div>
                  <h2>{language === "ar" ? "فتح درج النقدية" : "Open cash drawer"}</h2>
                  <p>{language === "ar" ? "أدخل النقد الموجود فعلياً في الدرج عند بداية الوردية." : "Enter the cash physically placed in the drawer at the start of the shift."}</p>
                </div>
              </div>
              <button className="icon-button" onClick={() => setOpenShiftDialog(false)}><X /></button>
            </header>
            <label className="cash-input">
              <span>{language === "ar" ? "النقد الموجود في الدرج" : "Cash in drawer"}</span>
              <div>
                <span>EGP</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={openingCash / 100 || ""}
                  onChange={(event) => setOpeningCash(Math.max(0, Math.round(Number(event.target.value) * 100)))}
                  autoFocus
                />
              </div>
            </label>
            <button className="primary-button checkout-confirm" onClick={() => void openShift()} disabled={openingShift}>
              {openingShift ? (language === "ar" ? "جارٍ الفتح…" : "Opening…") : (language === "ar" ? "بدء الوردية" : "Start shift")}
            </button>
          </section>
        </div>
      )}

      {joinShiftDialog && context && (
        <div className="modal-backdrop">
          <section className="modal compact-modal pos-join-modal">
            <header>
              <div>
                <span><UserPlus size={22} /></span>
                <div>
                  <h2>{language === "ar" ? "الانضمام إلى نقطة البيع" : "Join this POS"}</h2>
                  <p>{language === "ar" ? "يسجل الموظف دخوله بكلمة مروره ويبدأ ورديته دون إنهاء جلسة الموظف الآخر." : "The employee signs in with their own password. The current order and other shifts stay open."}</p>
                </div>
              </div>
              <button className="icon-button" onClick={() => setJoinShiftDialog(false)}><X /></button>
            </header>
            <label className="field">
              <span>{language === "ar" ? "الموظف" : "Employee"}</span>
              <select value={joiningUserId} onChange={(event) => setJoiningUserId(event.target.value)} autoFocus>
                <option value="">{language === "ar" ? "اختر الموظف" : "Select employee"}</option>
                {context.staff.map((employee) => {
                  const isOpen = context.openShifts.some((shift) => shift.user_id === employee.id);
                  return (
                    <option key={employee.id} value={employee.id}>
                      {language === "ar" ? employee.name_ar : employee.name}{isOpen ? (language === "ar" ? " — الوردية مفتوحة" : " — shift open") : ""}
                    </option>
                  );
                })}
              </select>
            </label>
            <label className="field">
              <span>{language === "ar" ? "كلمة المرور" : "Password"}</span>
              <input
                type="password"
                value={joiningPassword}
                onChange={(event) => setJoiningPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void joinShift();
                }}
                autoComplete="current-password"
              />
            </label>
            {joinError && <div className="form-error">{joinError}</div>}
            <button className="primary-button checkout-confirm" onClick={() => void joinShift()} disabled={joiningShift || !joiningUserId || !joiningPassword}>
              {joiningShift ? (language === "ar" ? "جارٍ تسجيل الدخول…" : "Signing in…") : (language === "ar" ? "بدء الوردية على هذا الجهاز" : "Start shift on this device")}
            </button>
          </section>
        </div>
      )}

      {closeShiftDialog && activeShift && (
        <div className="modal-backdrop">
          <section className="modal compact-modal">
            <header>
              <div>
                <span><Banknote size={22} /></span>
                <div>
                  <h2>{language === "ar" ? `إنهاء وردية ${activeShift.user_name_ar}` : `End ${activeShift.user_name}'s shift`}</h2>
                  <p>{activeShift.shared_drawer ? (language === "ar" ? "هذه وردية متداخلة على درج مشترك. سيتم تسجيل وقت الانتهاء دون فرق نقدي، وستبقى ورديات الموظفين الآخرين مفتوحة." : "This is an overlapping shared-drawer shift. Its end time will be recorded without a cash variance, and the other employees stay on duty.") : (language === "ar" ? "أدخل النقد المعدود فعلياً في الدرج." : "Count the physical cash in the drawer and enter it here.")}</p>
                </div>
              </div>
              <button className="icon-button" onClick={() => setCloseShiftDialog(false)}><X /></button>
            </header>
            {!activeShift.shared_drawer && <label className="cash-input">
              <span>{language === "ar" ? "النقد عند الإغلاق" : "Closing cash"}</span>
              <div>
                <span>EGP</span>
                <input type="number" min="0" step="0.01" value={closingCash / 100 || ""} onChange={(event) => setClosingCash(Math.max(0, Math.round(Number(event.target.value) * 100)))} autoFocus />
              </div>
            </label>}
            <button className="primary-button checkout-confirm" onClick={() => void closeShift()} disabled={closingShift}>
              {closingShift ? (language === "ar" ? "جارٍ الإغلاق…" : "Closing…") : (language === "ar" ? "إنهاء هذه الوردية" : "End this shift")}
            </button>
          </section>
        </div>
      )}

      {receipt && (
        <div className="modal-backdrop">
          <section className="modal receipt-modal">
            <div className="success-mark">
              <Check size={28} />
            </div>
            <h2>Payment complete</h2>
            <p>Order #{receipt.orderNumber}</p>
            <div className="receipt-paper receipt-paper--journal" dir="ltr" data-no-localize>
              <div className="receipt-brand">
                <span className="receipt-journal-mark">T&amp;T</span>
                <strong>{context?.brand.name ?? "Talk & TASTE"}</strong>
                {context?.receipt.showBranch !== false && (
                  <>
                    <small>{context?.branch.name}</small>
                    {context?.branch.address && <small>{context.branch.address}</small>}
                  </>
                )}
              </div>
              <hr />
              <div className="receipt-journal-order">
                <strong>ORDER #{receipt.orderNumber}</strong>
                <span>SALE</span>
              </div>
              <div>
                <span>Date</span>
                <strong>
                  {new Date(receipt.createdAt).toLocaleString("en-EG")}
                </strong>
              </div>
              <div>
                <span>Barista</span>
                <strong>{receipt.userName ?? context?.barista}</strong>
              </div>
              <hr />
              <div className="receipt-journal-labels">
                <span>ITEM</span>
                <span>AMOUNT</span>
              </div>
              {receipt.items?.map((item, index) => (
                <div className="receipt-line" key={index}>
                  <span>
                    {item.quantity} ×{" "}
                    {item.name}
                    {item.variantName ? ` · ${item.variantName}` : ""}
                  </span>
                  <strong>{receiptMoney(item.total)}</strong>
                </div>
              ))}
              <hr />
              <div>
                <span>Subtotal</span>
                <strong>{receiptMoney(receipt.subtotal)}</strong>
              </div>
              <div>
                <span>Payment</span>
                <strong className="capitalize">{receipt.paymentMethod}</strong>
              </div>
              {receipt.discountAmount > 0 && (
                <div>
                  <span>Discount</span>
                  <strong>−{receiptMoney(receipt.discountAmount)}</strong>
                </div>
              )}
              {receipt.taxAmount > 0 && (
                <div>
                  <span>Tax</span>
                  <strong>{receiptMoney(receipt.taxAmount)}</strong>
                </div>
              )}
              <div className="receipt-total">
                <span>TOTAL</span>
                <strong>{receiptMoney(receipt.total)}</strong>
              </div>
              {receipt.customerBalance != null && (
                <div>
                  <span>Customer balance</span>
                  <strong>{receiptMoney(receipt.customerBalance)}</strong>
                </div>
              )}
              <footer className="receipt-footer receipt-journal-footer">
                <strong>If you didn't like it, don't pay.</strong>
                <QRCodeSVG
                  value="https://talkandtaste.app"
                  size={88}
                  level="M"
                  marginSize={2}
                  title="Open the Talk & TASTE app"
                />
                <span>talkandtaste.app</span>
              </footer>
            </div>
            <div className="receipt-actions">
              <button className="soft-button" onClick={() => window.print()}>
                <Printer size={18} />
                {t("print")}
              </button>
              <button
                className="primary-button"
                onClick={() => setReceipt(null)}
              >
                New order
              </button>
            </div>
          </section>
        </div>
      )}
      {heldOpen && (
        <div className="modal-backdrop">
          <section className="modal compact-modal">
            <header>
              <div>
                <span>
                  <Pause />
                </span>
                <div>
                  <h2>Held orders</h2>
                  <p>Resume an order without losing its history.</p>
                </div>
              </div>
              <button
                className="icon-button"
                onClick={() => setHeldOpen(false)}
              >
                <X />
              </button>
            </header>
            <div className="held-list">
              {context?.heldOrders?.length ? (
                context.heldOrders.map((held) => (
                  <div className="held-order-row" key={held.id}>
                  <button onClick={() => resumeHeld(held)}>
                    <span>
                      <ReceiptText />
                    </span>
                    <div>
                      <strong>{held.note || "Counter order"}</strong>
                      <small>
                        {held.cart.items.length} items ·{" "}
                        {new Date(held.created_at).toLocaleTimeString(language === "ar" ? "ar-EG" : "en-EG")}
                      </small>
                    </div>
                    <b>{money(held.total)}</b>
                  </button>
                  <button className="held-order-remove" title={language === "ar" ? "حذف الطلب المعلّق" : "Remove held order"} onClick={() => void removeHeld(held.id)}>
                    <Trash2 size={16} />
                  </button>
                  </div>
                ))
              ) : (
                <EmptyState
                  icon={Pause}
                  title="No held orders"
                  description="Suspended orders will remain safely stored here."
                />
              )}
            </div>
          </section>
        </div>
      )}
      {variantProduct && (
        <div className="modal-backdrop">
          <section className="modal compact-modal">
            <header>
              <div>
                <span>{variantProduct.image}</span>
                <div>
                  <h2>
                    {language === "ar"
                      ? variantProduct.name_ar
                      : variantProduct.name}
                  </h2>
                  <p>Choose an option</p>
                </div>
              </div>
              <button
                className="icon-button"
                onClick={() => setVariantProduct(null)}
              >
                <X />
              </button>
            </header>
            <div className="variant-choice">
              {variants
                .filter((variant) => variant.product_id === variantProduct.id)
                .map((variant) => (
                  <button
                    key={variant.id}
                    disabled={variant.track_stock && variant.stock <= 0}
                    onClick={() => add(variantProduct, variant)}
                  >
                    <div>
                      <strong>
                        {language === "ar" ? variant.name_ar : variant.name}
                      </strong>
                      {variant.estimated_weight && (
                        <small>
                          {variant.estimated_weight}{" "}
                          {variant.estimated_weight_unit}
                        </small>
                      )}
                      {variant.track_stock && (
                        <small>
                          {variant.stock > 0
                            ? `${variant.stock} available`
                            : "Sold out"}
                        </small>
                      )}
                    </div>
                    <b>{money(variant.price)}</b>
                    <Plus />
                  </button>
                ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
