import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Coffee,
  FolderPlus,
  PackagePlus,
  Pencil,
  Plus,
  Search,
  Tag,
  X,
} from "lucide-react";
import { formatMoney } from "@token-taste/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { useI18n } from "../i18n";
import { StatusBadge } from "../components/StatusBadge";

type Category = {
  id: string;
  name: string;
  name_ar: string;
  icon: string;
  color: string;
  active: boolean;
};
type Product = {
  id: string;
  category_id: string;
  category_name: string;
  category_name_ar: string;
  sku: string;
  barcode: string | null;
  name: string;
  name_ar: string;
  description: string;
  notes: string;
  price: number;
  cost: number;
  stock: number;
  low_stock_at: number;
  image: string;
  color: string;
  track_stock: boolean;
  active: boolean;
};
type Ingredient = { id: string; name: string; name_ar: string; unit: string };
type Branch = { id: string; name: string; name_ar: string };
type VariantForm = {
  id?: string;
  name: string;
  nameAr: string;
  price: number;
  cost: number;
  sku: string;
  ingredientId: string;
  estimatedWeight: number;
  estimatedWeightUnit: string;
  stock: number;
  lowStockAt: number;
  trackStock: boolean;
};
type ProductVariant = {
  id: string;
  product_id: string;
  name: string;
  name_ar: string;
  price: number;
  cost: number;
  sku: string | null;
  estimated_weight: number | null;
  estimated_weight_unit: string | null;
  stock: number;
  low_stock_at: number;
  track_stock: boolean;
  active: boolean;
};
type Recipe = {
  product_id: string;
  variant_id: string | null;
  inventory_item_id: string;
  quantity: number;
  unit: string;
};
type Availability = {
  product_id: string;
  branch_id: string;
  available: number;
};
type ProductForm = {
  categoryId: string;
  sku: string;
  barcode: string;
  name: string;
  nameAr: string;
  description: string;
  notes: string;
  price: number;
  cost: number;
  stock: number;
  lowStockAt: number;
  image: string;
  color: string;
  trackStock: boolean;
  active: boolean;
  branchIds: string[];
  ingredientId: string;
  estimatedWeight: number;
  estimatedWeightUnit: string;
  variants: VariantForm[];
};
const emptyProduct: ProductForm = {
  categoryId: "",
  sku: "",
  barcode: "",
  name: "",
  nameAr: "",
  description: "",
  notes: "",
  price: 0,
  cost: 0,
  stock: 0,
  lowStockAt: 5,
  image: "☕",
  color: "#E9D7C8",
  trackStock: true,
  active: true,
  branchIds: [],
  ingredientId: "",
  estimatedWeight: 0,
  estimatedWeightUnit: "grams",
  variants: [],
};

export function ProductsPage() {
  const { can } = useAuth();
  const { language, t } = useI18n();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [availability, setAvailability] = useState<Availability[]>([]);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [removedVariantIds, setRemovedVariantIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"products" | "categories">("products");
  const [productOpen, setProductOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(
    null,
  );
  const [productForm, setProductForm] = useState(emptyProduct);
  const [categoryForm, setCategoryForm] = useState({
    name: "",
    nameAr: "",
    color: "#C9976A",
    active: true,
  });
  const load = () =>
    api<{
      products: Product[];
      categories: Category[];
      ingredients: Ingredient[];
      branches: Branch[];
      variants: ProductVariant[];
      recipes: Recipe[];
      availability: Availability[];
    }>("/api/admin/catalog").then((data) => {
      setProducts(data.products);
      setCategories(data.categories);
      setIngredients(data.ingredients);
      setBranches(data.branches);
      setVariants(data.variants);
      setRecipes(data.recipes);
      setAvailability(data.availability);
    });
  useEffect(() => {
    void load();
  }, []);
  const filtered = useMemo(
    () =>
      products.filter((product) =>
        `${product.name} ${product.name_ar} ${product.sku}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [products, search],
  );
  const saveProduct = async (event: FormEvent) => {
    event.preventDefault();
    const productPayload = {
      ...productForm,
      price: Math.round(productForm.price * 100),
      cost: Math.round(productForm.cost * 100),
      variants: productForm.variants.map((variant) => ({
        ...variant,
        price: Math.round(variant.price * 100),
        cost: Math.round(variant.cost * 100),
      })),
    };
    if (editingProductId) {
      await api(`/api/products/${editingProductId}`, {
        method: "PATCH",
        body: JSON.stringify(productPayload),
      });
      for (const variant of productPayload.variants) {
        await api(
          variant.id
            ? `/api/variants/${variant.id}`
            : `/api/products/${editingProductId}/variants`,
          {
            method: variant.id ? "PATCH" : "POST",
            body: JSON.stringify(variant),
          },
        );
      }
      for (const id of removedVariantIds) {
        await api(`/api/variants/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ active: false }),
        });
      }
    } else {
      await api("/api/products", {
        method: "POST",
        body: JSON.stringify(productPayload),
      });
    }
    setProductOpen(false);
    setProductForm(emptyProduct);
    setEditingProductId(null);
    setRemovedVariantIds([]);
    await load();
  };
  const addVariant = () =>
    setProductForm({
      ...productForm,
      variants: [
        ...productForm.variants,
        {
          name: "",
          nameAr: "",
          price: productForm.price,
          cost: productForm.cost,
          sku: "",
          ingredientId: "",
          estimatedWeight: 0,
          estimatedWeightUnit: "grams",
          stock: 0,
          lowStockAt: 0,
          trackStock: false,
        },
      ],
    });
  const updateVariant = (index: number, changes: Partial<VariantForm>) =>
    setProductForm({
      ...productForm,
      variants: productForm.variants.map((variant, position) =>
        position === index ? { ...variant, ...changes } : variant,
      ),
    });
  const createCategory = async (event: FormEvent) => {
    event.preventDefault();
    await api(
      editingCategoryId
        ? `/api/categories/${editingCategoryId}`
        : "/api/categories",
      {
        method: editingCategoryId ? "PATCH" : "POST",
        body: JSON.stringify(categoryForm),
      },
    );
    setCategoryOpen(false);
    setEditingCategoryId(null);
    setCategoryForm({ name: "", nameAr: "", color: "#C9976A", active: true });
    await load();
  };
  const editProduct = (product: Product) => {
    const productAvailability = availability.filter(
      (item) => item.product_id === product.id,
    );
    const baseRecipe = recipes.find(
      (item) => item.variant_id === null && item.product_id === product.id,
    );
    setProductForm({
      categoryId: product.category_id,
      sku: product.sku ?? "",
      barcode: product.barcode ?? "",
      name: product.name,
      nameAr: product.name_ar,
      description: product.description ?? "",
      notes: product.notes ?? "",
      price: product.price / 100,
      cost: product.cost / 100,
      stock: product.stock,
      lowStockAt: product.low_stock_at,
      image: product.image,
      color: product.color,
      trackStock: product.track_stock,
      active: product.active,
      branchIds: productAvailability.length
        ? productAvailability
            .filter((item) => Boolean(item.available))
            .map((item) => item.branch_id)
        : branches.map((item) => item.id),
      ingredientId: baseRecipe?.inventory_item_id ?? "",
      estimatedWeight: baseRecipe?.quantity ?? 0,
      estimatedWeightUnit: baseRecipe?.unit ?? "grams",
      variants: variants
        .filter(
          (variant) => variant.product_id === product.id && variant.active,
        )
        .map((variant) => {
          const recipe = recipes.find((item) => item.variant_id === variant.id);
          return {
            id: variant.id,
            name: variant.name,
            nameAr: variant.name_ar,
            price: variant.price / 100,
            cost: variant.cost / 100,
            sku: variant.sku ?? "",
            ingredientId: recipe?.inventory_item_id ?? "",
            estimatedWeight: recipe?.quantity ?? variant.estimated_weight ?? 0,
            estimatedWeightUnit:
              recipe?.unit ?? variant.estimated_weight_unit ?? "grams",
            stock: variant.stock,
            lowStockAt: variant.low_stock_at,
            trackStock: variant.track_stock,
          };
        }),
    });
    setRemovedVariantIds([]);
    setEditingProductId(product.id);
    setProductOpen(true);
  };

  return (
    <div className="content-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Catalog management</span>
          <h2>{t("products")}</h2>
          <p>Bilingual products, categories, pricing, and stock behavior.</p>
        </div>
        <div className="heading-actions">
          {can("categories.manage") && (
            <button
              className="soft-button"
              onClick={() => {
                setEditingCategoryId(null);
                setCategoryForm({
                  name: "",
                  nameAr: "",
                  color: "#C9976A",
                  active: true,
                });
                setCategoryOpen(true);
              }}
            >
              <FolderPlus size={18} /> Category
            </button>
          )}
          <button
            className="primary-button"
            onClick={() => {
              setEditingProductId(null);
              setRemovedVariantIds([]);
              setProductForm({
                ...emptyProduct,
                categoryId: categories[0]?.id ?? "",
                branchIds: branches.map((item) => item.id),
              });
              setProductOpen(true);
            }}
          >
            <Plus size={18} /> Add product
          </button>
        </div>
      </div>
      <div className="mini-metrics">
        <article>
          <span>
            <Coffee />
          </span>
          <div>
            <small>Active products</small>
            <strong>{products.filter((p) => p.active).length}</strong>
          </div>
        </article>
        <article>
          <span className="success">
            <Tag />
          </span>
          <div>
            <small>Categories</small>
            <strong>{categories.length}</strong>
          </div>
        </article>
        <article>
          <span className="warning">
            <PackagePlus />
          </span>
          <div>
            <small>Stock tracked</small>
            <strong>{products.filter((p) => p.track_stock).length}</strong>
          </div>
        </article>
      </div>
      <section className="panel table-panel">
        <div className="table-toolbar">
          <div className="segmented">
            <button
              className={tab === "products" ? "active" : ""}
              onClick={() => setTab("products")}
            >
              Products
            </button>
            <button
              className={tab === "categories" ? "active" : ""}
              onClick={() => setTab("categories")}
            >
              Categories
            </button>
          </div>
          <label>
            <Search size={18} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search catalog"
            />
          </label>
        </div>
        {tab === "products" ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("product")}</th>
                  <th>SKU</th>
                  <th>{t("category")}</th>
                  <th>{t("price")}</th>
                  <th>Cost</th>
                  <th>Profit / margin</th>
                  <th>{t("stock")}</th>
                  <th>{t("status")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((product) => (
                  <tr key={product.id}>
                    <td>
                      <div className="product-cell">
                        <span style={{ background: product.color }}>
                          {product.image}
                        </span>
                        <div>
                          <strong>
                            {language === "ar" ? product.name_ar : product.name}
                          </strong>
                          {language !== "ar" && <small>{product.name_ar}</small>}
                        </div>
                      </div>
                    </td>
                    <td>
                      <code>{product.sku}</code>
                    </td>
                    <td>{language === "ar" ? product.category_name_ar : product.category_name}</td>
                    <td>
                      <strong>{formatMoney(product.price, language)}</strong>
                    </td>
                    <td>{formatMoney(product.cost, language)}</td>
                    <td>
                      <strong>
                        {formatMoney(product.price - product.cost, language)}
                      </strong>
                      <small>
                        {product.price
                          ? Math.round(
                              ((product.price - product.cost) / product.price) *
                                100,
                            )
                          : 0}
                        % estimated margin
                      </small>
                    </td>
                    <td>
                      {product.track_stock
                        ? `${product.stock} units`
                        : "Not tracked"}
                    </td>
                    <td>
                      <StatusBadge
                        value={product.active ? "Active" : "Disabled"}
                      />
                    </td>
                    <td>
                      <button
                        className="icon-button"
                        onClick={() => editProduct(product)}
                        title="Edit product"
                      >
                        <Pencil size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="category-admin-grid">
            {categories.map((category) => (
              <article key={category.id}>
                <span
                  style={{
                    background: `${category.color}22`,
                    color: category.color,
                  }}
                >
                  <Coffee />
                </span>
                <div>
                  <h3>
                    {language === "ar" ? category.name_ar : category.name}
                  </h3>
                  {language !== "ar" && <p>{category.name_ar}</p>}
                  <small>
                    {
                      products.filter(
                        (product) => product.category_id === category.id,
                      ).length
                    }{" "}
                    products
                  </small>
                </div>
                <div className="category-actions">
                  <StatusBadge
                    value={category.active ? "Active" : "Disabled"}
                  />
                  {can("categories.manage") && (
                    <button
                      className="icon-button"
                      onClick={() => {
                        setEditingCategoryId(category.id);
                        setCategoryForm({
                          name: category.name,
                          nameAr: category.name_ar,
                          color: category.color,
                          active: category.active,
                        });
                        setCategoryOpen(true);
                      }}
                      title="Edit category"
                    >
                      <Pencil size={15} />
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {productOpen && (
        <div className="modal-backdrop">
          <form className="modal form-modal" onSubmit={saveProduct}>
            <header>
              <div>
                <span>
                  <PackagePlus />
                </span>
                <div>
                  <h2>{editingProductId ? "Edit product" : "Add product"}</h2>
                  <p>
                    {editingProductId
                      ? "Update catalog details, availability, and options."
                      : "Only names, category, and selling price are required."}
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setProductOpen(false)}
              >
                <X />
              </button>
            </header>
            <div className="field-row">
              <label className="field">
                <span>English name</span>
                <input
                  value={productForm.name}
                  onChange={(e) =>
                    setProductForm({ ...productForm, name: e.target.value })
                  }
                  required
                />
              </label>
              <label className="field">
                <span>الاسم بالعربية</span>
                <input
                  dir="rtl"
                  value={productForm.nameAr}
                  onChange={(e) =>
                    setProductForm({ ...productForm, nameAr: e.target.value })
                  }
                  required
                />
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>SKU · optional</span>
                <input
                  value={productForm.sku}
                  onChange={(e) =>
                    setProductForm({ ...productForm, sku: e.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Category</span>
                <select
                  value={productForm.categoryId}
                  onChange={(e) =>
                    setProductForm({
                      ...productForm,
                      categoryId: e.target.value,
                    })
                  }
                  required
                >
                  <option value="">Select category</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>Barcode · optional</span>
                <input
                  value={productForm.barcode}
                  onChange={(e) =>
                    setProductForm({ ...productForm, barcode: e.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Description · optional</span>
                <input
                  value={productForm.description}
                  onChange={(e) =>
                    setProductForm({
                      ...productForm,
                      description: e.target.value,
                    })
                  }
                />
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>Price (EGP)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={productForm.price || ""}
                  onChange={(e) =>
                    setProductForm({
                      ...productForm,
                      price: Number(e.target.value),
                    })
                  }
                  required
                />
              </label>
              <label className="field">
                <span>Cost (EGP)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={productForm.cost || ""}
                  onChange={(e) =>
                    setProductForm({
                      ...productForm,
                      cost: Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>Opening stock</span>
                <input
                  type="number"
                  min="0"
                  value={productForm.stock}
                  onChange={(e) =>
                    setProductForm({
                      ...productForm,
                      stock: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Low-stock alert at</span>
                <input
                  type="number"
                  min="0"
                  value={productForm.lowStockAt}
                  onChange={(e) =>
                    setProductForm({
                      ...productForm,
                      lowStockAt: Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>Product symbol</span>
                <input
                  value={productForm.image}
                  maxLength={4}
                  onChange={(e) =>
                    setProductForm({ ...productForm, image: e.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Card color</span>
                <input
                  type="color"
                  value={productForm.color}
                  onChange={(e) =>
                    setProductForm({ ...productForm, color: e.target.value })
                  }
                />
              </label>
            </div>
            <label className="switch-field">
              <input
                type="checkbox"
                checked={productForm.trackStock}
                onChange={(e) =>
                  setProductForm({
                    ...productForm,
                    trackStock: e.target.checked,
                  })
                }
              />
              <i />
              <div>
                <strong>Track finished-product stock</strong>
                <small>Useful for Pepsi, chips, and packaged products.</small>
              </div>
            </label>
            <details className="advanced-fields">
              <summary>
                Advanced · variants and estimated usage{" "}
                <span>{productForm.variants.length || "Optional"}</span>
              </summary>
              <div>
                <p>
                  Link the base product or its options to ingredients for
                  automatic theoretical consumption.
                </p>
                <div className="field-row">
                  <label className="field">
                    <span>Base ingredient · optional</span>
                    <select
                      value={productForm.ingredientId}
                      onChange={(event) => {
                        const ingredient = ingredients.find(
                          (item) => item.id === event.target.value,
                        );
                        setProductForm({
                          ...productForm,
                          ingredientId: event.target.value,
                          estimatedWeightUnit:
                            ingredient?.unit ?? productForm.estimatedWeightUnit,
                        });
                      }}
                    >
                      <option value="">No automatic consumption</option>
                      {ingredients.map((item) => (
                        <option key={item.id} value={item.id}>
                          {language === "ar" ? item.name_ar : item.name} ·{" "}
                          {item.unit}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Base estimated usage</span>
                    <div className="inline-fields">
                      <input
                        type="number"
                        min="0"
                        step=".1"
                        value={productForm.estimatedWeight || ""}
                        disabled={!productForm.ingredientId}
                        onChange={(event) =>
                          setProductForm({
                            ...productForm,
                            estimatedWeight: Number(event.target.value),
                          })
                        }
                      />
                      <input
                        value={productForm.estimatedWeightUnit}
                        disabled
                        aria-label="Base usage unit"
                      />
                    </div>
                  </label>
                </div>
                <label className="field">
                  <span>Internal notes</span>
                  <textarea
                    rows={2}
                    value={productForm.notes}
                    onChange={(e) =>
                      setProductForm({ ...productForm, notes: e.target.value })
                    }
                  />
                </label>
                <div className="branch-availability">
                  <strong>Available at branches</strong>
                  {branches.map((branch) => (
                    <label key={branch.id}>
                      <input
                        type="checkbox"
                        checked={productForm.branchIds.includes(branch.id)}
                        onChange={() =>
                          setProductForm({
                            ...productForm,
                            branchIds: productForm.branchIds.includes(branch.id)
                              ? productForm.branchIds.filter(
                                  (id) => id !== branch.id,
                                )
                              : [...productForm.branchIds, branch.id],
                          })
                        }
                      />
                      <span>
                        {language === "ar" ? branch.name_ar : branch.name}
                      </span>
                    </label>
                  ))}
                </div>
                {productForm.variants.map((variant, index) => (
                  <section className="variant-form" key={index}>
                    <header>
                      <strong>Option {index + 1}</strong>
                      <button
                        type="button"
                        onClick={() => {
                          if (variant.id)
                            setRemovedVariantIds([
                              ...removedVariantIds,
                              variant.id,
                            ]);
                          setProductForm({
                            ...productForm,
                            variants: productForm.variants.filter(
                              (_, position) => position !== index,
                            ),
                          });
                        }}
                      >
                        Remove
                      </button>
                    </header>
                    <div className="field-row">
                      <label className="field">
                        <span>English name</span>
                        <input
                          required
                          value={variant.name}
                          onChange={(e) =>
                            updateVariant(index, { name: e.target.value })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>الاسم بالعربية</span>
                        <input
                          required
                          dir="rtl"
                          value={variant.nameAr}
                          onChange={(e) =>
                            updateVariant(index, { nameAr: e.target.value })
                          }
                        />
                      </label>
                    </div>
                    <div className="field-row">
                      <label className="field">
                        <span>Ingredient · optional</span>
                        <select
                          value={variant.ingredientId}
                          onChange={(e) => {
                            const ingredient = ingredients.find(
                              (item) => item.id === e.target.value,
                            );
                            updateVariant(index, {
                              ingredientId: e.target.value,
                              estimatedWeightUnit:
                                ingredient?.unit ?? variant.estimatedWeightUnit,
                            });
                          }}
                        >
                          <option value="">No automatic consumption</option>
                          {ingredients.map((item) => (
                            <option key={item.id} value={item.id}>
                              {language === "ar" ? item.name_ar : item.name} ·{" "}
                              {item.unit}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>Variant SKU · optional</span>
                        <input
                          value={variant.sku}
                          onChange={(e) =>
                            updateVariant(index, { sku: e.target.value })
                          }
                        />
                      </label>
                    </div>
                    <div className="variant-field-row">
                      <label>
                        Price EGP
                        <input
                          type="number"
                          min="0"
                          step=".01"
                          value={variant.price || ""}
                          onChange={(e) =>
                            updateVariant(index, {
                              price: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Cost EGP
                        <input
                          type="number"
                          min="0"
                          step=".01"
                          value={variant.cost || ""}
                          onChange={(e) =>
                            updateVariant(index, {
                              cost: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Est. usage
                        <input
                          type="number"
                          min="0"
                          step=".1"
                          value={variant.estimatedWeight || ""}
                          onChange={(e) =>
                            updateVariant(index, {
                              estimatedWeight: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Unit
                        <select
                          value={variant.estimatedWeightUnit}
                          disabled={Boolean(variant.ingredientId)}
                          onChange={(e) =>
                            updateVariant(index, {
                              estimatedWeightUnit: e.target.value,
                            })
                          }
                        >
                          <option>grams</option>
                          <option>kilograms</option>
                          <option>milliliters</option>
                          <option>liters</option>
                          <option>pieces</option>
                        </select>
                      </label>
                    </div>
                    <label className="switch-field variant-stock-switch">
                      <input
                        type="checkbox"
                        checked={variant.trackStock}
                        onChange={(e) =>
                          updateVariant(index, { trackStock: e.target.checked })
                        }
                      />
                      <i />
                      <div>
                        <strong>Track stock for this option</strong>
                        <small>
                          Overrides the shared product stock when enabled.
                        </small>
                      </div>
                    </label>
                    {variant.trackStock && (
                      <div className="field-row">
                        <label className="field">
                          <span>Option opening stock</span>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={variant.stock}
                            onChange={(e) =>
                              updateVariant(index, {
                                stock: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                        <label className="field">
                          <span>Option low-stock alert</span>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={variant.lowStockAt}
                            onChange={(e) =>
                              updateVariant(index, {
                                lowStockAt: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                      </div>
                    )}
                  </section>
                ))}
                <button
                  type="button"
                  className="soft-button"
                  onClick={addVariant}
                >
                  <Plus /> Add variant
                </button>
              </div>
            </details>
            {editingProductId && (
              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={productForm.active}
                  onChange={(event) =>
                    setProductForm({
                      ...productForm,
                      active: event.target.checked,
                    })
                  }
                />
                <i />
                <div>
                  <strong>Product available for sale</strong>
                  <small>Disabled products remain in historical reports.</small>
                </div>
              </label>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="soft-button"
                onClick={() => setProductOpen(false)}
              >
                {t("cancel")}
              </button>
              <button className="primary-button">
                {editingProductId ? "Save changes" : "Create product"}
              </button>
            </div>
          </form>
        </div>
      )}
      {categoryOpen && (
        <div className="modal-backdrop">
          <form className="modal compact-modal" onSubmit={createCategory}>
            <header>
              <div>
                <span>
                  <FolderPlus />
                </span>
                <div>
                  <h2>
                    {editingCategoryId ? "Edit category" : "Add category"}
                  </h2>
                  <p>
                    {editingCategoryId
                      ? "Update this bilingual menu group."
                      : "Create a bilingual menu group."}
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setCategoryOpen(false)}
              >
                <X />
              </button>
            </header>
            <label className="field">
              <span>English name</span>
              <input
                value={categoryForm.name}
                onChange={(e) =>
                  setCategoryForm({ ...categoryForm, name: e.target.value })
                }
                required
              />
            </label>
            {editingCategoryId && (
              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={categoryForm.active}
                  onChange={(e) =>
                    setCategoryForm({
                      ...categoryForm,
                      active: e.target.checked,
                    })
                  }
                />
                <i />
                <div>
                  <strong>Category available for sale</strong>
                  <small>Disabling preserves historical transactions.</small>
                </div>
              </label>
            )}
            <label className="field">
              <span>الاسم بالعربية</span>
              <input
                dir="rtl"
                value={categoryForm.nameAr}
                onChange={(e) =>
                  setCategoryForm({ ...categoryForm, nameAr: e.target.value })
                }
                required
              />
            </label>
            <label className="field">
              <span>Accent color</span>
              <input
                type="color"
                value={categoryForm.color}
                onChange={(e) =>
                  setCategoryForm({ ...categoryForm, color: e.target.value })
                }
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="soft-button"
                onClick={() => setCategoryOpen(false)}
              >
                {t("cancel")}
              </button>
              <button className="primary-button">
                {editingCategoryId ? "Save changes" : "Create category"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
