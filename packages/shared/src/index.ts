import { z } from "zod";

export const permissions = [
  "pos.access",
  "pos.discount",
  "pos.void",
  "pos.reprint",
  "pos.drawer",
  "pos.shift",
  "pos.history",
  "sales.view",
  "reports.daily",
  "reports.financial",
  "treasury.manage",
  "inventory.manage",
  "products.manage",
  "categories.manage",
  "staff.manage",
  "customers.manage",
  "credit.manage",
  "branches.manage",
  "audit.view",
  "shifts.manage",
  "expenses.manage",
  "payroll.view",
  "settings.manage",
] as const;

export type Permission = (typeof permissions)[number];
export type Language = "en" | "ar";
export type PaymentMethod = "cash" | "card" | "credit";
export type SyncState = "synced" | "syncing" | "offline" | "pending" | "error";

export const checkoutSchema = z.object({
  clientRequestId: z.string().uuid(),
  shiftId: z.string().uuid(),
  customerId: z.string().uuid().nullable().optional(),
  paymentMethod: z.enum(["cash", "card", "credit"]),
  discountAmount: z.number().int().min(0).default(0),
  note: z.string().max(500).default(""),
  heldOrderId: z.string().uuid().nullable().optional(),
  activityLog: z
    .array(
      z.object({
        action: z.enum([
          "item.added",
          "item.removed",
          "item.quantity_changed",
          "discount.changed",
          "payment.changed",
          "note.changed",
        ]),
        productId: z.string().uuid().nullable().optional(),
        originalValue: z.unknown().optional(),
        newValue: z.unknown().optional(),
        occurredAt: z.string().datetime(),
      }),
    )
    .max(250)
    .default([]),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        variantId: z.string().uuid().nullable().optional(),
        quantity: z.number().int().positive(),
        unitPrice: z.number().int().nonnegative(),
        note: z.string().max(250).default(""),
      }),
    )
    .min(1),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;

export interface SessionUser {
  id: string;
  name: string;
  nameAr: string;
  username: string;
  isSuperAdmin: boolean;
  permissions: Permission[];
  branchId: string;
  branchName: string;
  branchNameAr: string;
}

export interface Category {
  id: string;
  name: string;
  nameAr: string;
  icon: string;
  color: string;
  sortOrder: number;
  active: boolean;
}

export interface Product {
  id: string;
  categoryId: string;
  sku: string;
  name: string;
  nameAr: string;
  price: number;
  cost: number;
  stock: number;
  lowStockAt: number;
  image: string;
  color: string;
  active: boolean;
  trackStock: boolean;
}

export interface OrderItem {
  id: string;
  productId: string;
  name: string;
  nameAr: string;
  quantity: number;
  unitPrice: number;
  total: number;
  note: string;
}

export interface Order {
  id: string;
  orderNumber: string;
  status: "completed" | "refunded" | "voided" | "held";
  paymentMethod: PaymentMethod;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
  customerName: string | null;
  createdAt: string;
  userName: string;
  syncStatus: "pending" | "synced" | "error";
  items?: OrderItem[];
}

export const formatMoney = (piastres: number, language: Language = "en") => {
  const amount = piastres / 100;
  return new Intl.NumberFormat(language === "ar" ? "ar-EG" : "en-EG", {
    style: "currency",
    currency: "EGP",
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
};
