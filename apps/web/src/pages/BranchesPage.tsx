import { useEffect, useState, type FormEvent } from "react";
import { Cloud, Copy, Link2, Monitor, Pencil, Plus, Store, Users, X } from "lucide-react";
import { api } from "../api";
import { useI18n } from "../i18n";
import { StatusBadge } from "../components/StatusBadge";

type Branch = {
  id: string;
  code: string;
  name: string;
  name_ar: string;
  address: string;
  phone: string;
  notes: string;
  receipt_info: string;
  active: boolean;
  staff: number;
  device_last_seen_at: string | null;
  device_paired_at: string | null;
};

type Pairing = {
  code: string;
  expiresAt: string;
  branch: { id: string; name: string; name_ar: string };
};

const emptyBranch = {
  code: "",
  name: "",
  nameAr: "",
  address: "",
  phone: "",
  notes: "",
  receiptInfo: "",
};

export function BranchesPage() {
  const { language, t, tr } = useI18n();
  const [cloudManaged, setCloudManaged] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchOpen, setBranchOpen] = useState(false);
  const [editing, setEditing] = useState<Branch | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [branch, setBranch] = useState(emptyBranch);

  const load = () =>
    api<{ cloudManaged: boolean; branches: Branch[] }>("/api/branches").then(
      (data) => {
        setCloudManaged(data.cloudManaged);
        setBranches(data.branches);
      },
    );

  useEffect(() => {
    void load();
  }, []);

  const addBranch = async (event: FormEvent) => {
    event.preventDefault();
    await api("/api/branches", {
      method: "POST",
      body: JSON.stringify(branch),
    });
    setBranchOpen(false);
    setBranch(emptyBranch);
    await load();
  };

  const saveBranch = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    await api(`/api/branches/${editing.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: editing.name,
        nameAr: editing.name_ar,
        address: editing.address,
        phone: editing.phone,
        notes: editing.notes,
        receiptInfo: editing.receipt_info,
        active: editing.active,
      }),
    });
    setEditing(null);
    await load();
  };

  const createPairing = async (item: Branch) =>
    setPairing(
      await api<Pairing>(`/api/branches/${item.id}/pairing-code`, {
        method: "POST",
      }),
    );

  return (
    <div className="content-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{tr("Branch management", "إدارة الفروع")}</span>
          <h2>{t("branches")}</h2>
          <p>{tr("One Windows POS device for each physical branch.", "جهاز نقطة بيع ويندوز واحد لكل فرع فعلي.")}</p>
        </div>
        {cloudManaged && (
          <button className="primary-button" onClick={() => setBranchOpen(true)}>
            <Plus /> {tr("Add branch", "إضافة فرع")}
          </button>
        )}
      </div>

      {!cloudManaged && (
        <div className="config-note">
          <Cloud />
          <div>
            <strong>{tr("Branches are managed in Cloud Admin", "تُدار الفروع من لوحة السحابة")}</strong>
            <p>{tr("This Windows installation connects to a branch using its one-time pairing code in Settings.", "يتصل تثبيت ويندوز هذا بفرع باستخدام رمز الاقتران لمرة واحدة من الإعدادات.")}</p>
          </div>
        </div>
      )}

      <div className="branch-admin-grid">
        {branches.map((item) => (
          <article className="panel branch-card" key={item.id}>
            <header>
              <span><Store /></span>
              <StatusBadge value={item.active ? "Active" : "Disabled"} />
            </header>
            <h3>{language === "ar" ? item.name_ar : item.name}</h3>
            <p>{item.address || tr("No address added", "لم يُضف عنوان")}</p>
            <code>{item.code}</code>
            <footer>
              <span><Monitor /> {item.device_paired_at ? tr("Windows device paired", "جهاز ويندوز مقترن") : tr("No device paired", "لا يوجد جهاز مقترن")}</span>
              <span><Users /> {item.staff} {tr("staff", "موظف")}</span>
              {cloudManaged && (
                <>
                  <button className="soft-button small" disabled={!item.active} onClick={() => void createPairing(item)}><Link2 /> {tr("Pair Windows Device", "ربط جهاز ويندوز")}</button>
                  <button className="icon-button" onClick={() => setEditing(item)} aria-label={tr("Edit branch", "تعديل الفرع")}><Pencil /></button>
                </>
              )}
            </footer>
            {item.device_last_seen_at && <small>{tr("Device last seen", "آخر اتصال للجهاز")}: {new Date(item.device_last_seen_at).toLocaleString(language === "ar" ? "ar-EG" : "en-EG")}</small>}
          </article>
        ))}
      </div>

      {branchOpen && (
        <div className="modal-backdrop">
          <form className="modal compact-modal" onSubmit={addBranch}>
            <header><div><span><Store /></span><div><h2>{tr("Add branch", "إضافة فرع")}</h2><p>{tr("Create a physical cafe location.", "أنشئ موقع مقهى فعلياً.")}</p></div></div><button type="button" className="icon-button" onClick={() => setBranchOpen(false)}><X /></button></header>
            <label className="field"><span>{tr("Branch code", "رمز الفرع")}</span><input required placeholder="CITYSTARS" value={branch.code} onChange={(event) => setBranch({ ...branch, code: event.target.value })} /></label>
            <div className="field-row"><label className="field"><span>English name</span><input required value={branch.name} onChange={(event) => setBranch({ ...branch, name: event.target.value })} /></label><label className="field"><span>الاسم بالعربية</span><input required dir="rtl" value={branch.nameAr} onChange={(event) => setBranch({ ...branch, nameAr: event.target.value })} /></label></div>
            <div className="field-row"><label className="field"><span>{tr("Address", "العنوان")}</span><input value={branch.address} onChange={(event) => setBranch({ ...branch, address: event.target.value })} /></label><label className="field"><span>{tr("Phone", "الهاتف")}</span><input value={branch.phone} onChange={(event) => setBranch({ ...branch, phone: event.target.value })} /></label></div>
            <label className="field"><span>{tr("Receipt information", "بيانات الإيصال")}</span><input value={branch.receiptInfo} onChange={(event) => setBranch({ ...branch, receiptInfo: event.target.value })} /></label>
            <label className="field"><span>{tr("Notes", "ملاحظات")}</span><textarea rows={2} value={branch.notes} onChange={(event) => setBranch({ ...branch, notes: event.target.value })} /></label>
            <div className="modal-actions"><button type="button" className="soft-button" onClick={() => setBranchOpen(false)}>{t("cancel")}</button><button className="primary-button">{tr("Create branch", "إنشاء الفرع")}</button></div>
          </form>
        </div>
      )}

      {editing && (
        <div className="modal-backdrop">
          <form className="modal compact-modal" onSubmit={saveBranch}>
            <header><div><span><Pencil /></span><div><h2>{tr("Edit branch", "تعديل الفرع")}</h2><p>{editing.code}</p></div></div><button type="button" className="icon-button" onClick={() => setEditing(null)}><X /></button></header>
            <div className="field-row"><label className="field"><span>English name</span><input required value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label><label className="field"><span>الاسم بالعربية</span><input required dir="rtl" value={editing.name_ar} onChange={(event) => setEditing({ ...editing, name_ar: event.target.value })} /></label></div>
            <div className="field-row"><label className="field"><span>{tr("Address", "العنوان")}</span><input value={editing.address} onChange={(event) => setEditing({ ...editing, address: event.target.value })} /></label><label className="field"><span>{tr("Phone", "الهاتف")}</span><input value={editing.phone} onChange={(event) => setEditing({ ...editing, phone: event.target.value })} /></label></div>
            <label className="field"><span>{tr("Receipt information", "بيانات الإيصال")}</span><input value={editing.receipt_info} onChange={(event) => setEditing({ ...editing, receipt_info: event.target.value })} /></label>
            <label className="field"><span>{tr("Notes", "ملاحظات")}</span><textarea rows={2} value={editing.notes} onChange={(event) => setEditing({ ...editing, notes: event.target.value })} /></label>
            <label className="switch-field"><input type="checkbox" checked={editing.active} onChange={(event) => setEditing({ ...editing, active: event.target.checked })} /><i /><div><strong>{tr("Branch enabled", "الفرع مفعّل")}</strong><small>{tr("Disabled branches cannot pair a Windows device.", "لا يمكن للفروع المعطلة ربط جهاز ويندوز.")}</small></div></label>
            <div className="modal-actions"><button type="button" className="soft-button" onClick={() => setEditing(null)}>{t("cancel")}</button><button className="primary-button">{t("save")}</button></div>
          </form>
        </div>
      )}

      {pairing && (
        <div className="modal-backdrop">
          <div className="modal compact-modal pairing-modal">
            <header><div><span><Link2 /></span><div><h2>{tr("Pair Windows Device", "ربط جهاز ويندوز")}</h2><p>{language === "ar" ? pairing.branch.name_ar : pairing.branch.name}</p></div></div><button type="button" className="icon-button" onClick={() => setPairing(null)}><X /></button></header>
            <div className="pairing-code"><code>{pairing.code}</code><button className="soft-button" onClick={() => void navigator.clipboard.writeText(pairing.code)}><Copy /> {tr("Copy", "نسخ")}</button></div>
            <div className="config-note"><Link2 /><div><strong>{tr("Use once on the branch computer", "يُستخدم مرة واحدة على جهاز الفرع")}</strong><p>{tr("Open Talk & TASTE and enter this code in Settings. It expires at", "افتح Talk & TASTE وأدخل هذا الرمز في الإعدادات. تنتهي صلاحيته الساعة")} {new Date(pairing.expiresAt).toLocaleTimeString(language === "ar" ? "ar-EG" : "en-EG")}.</p></div></div>
            <div className="modal-actions"><button className="primary-button" onClick={() => setPairing(null)}>{tr("Done", "تم")}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
