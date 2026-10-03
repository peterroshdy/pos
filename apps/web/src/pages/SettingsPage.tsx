import { useEffect, useState } from "react";
import { Building2, Cloud, Link2, ReceiptText, Save, ShieldCheck } from "lucide-react";
import { api } from "../api";
import { useI18n } from "../i18n";

type SettingsData = {
  tax?: { enabled: boolean; rate: number; pricesIncludeTax: boolean };
  brand?: { name: string; currency: string; language: string };
  receipt?: {
    footer?: string;
    autoPrint?: boolean;
    bilingual?: boolean;
    showBranch?: boolean;
    drawerTrigger?: string;
  };
};

type SyncStatus = {
  mode: "branch" | "cloud";
  paired: boolean;
  state: "synced" | "pending" | "error" | "offline";
  pending: number;
  failed: number;
};

export function SettingsPage() {
  const { t, tr } = useI18n();
  const [settings, setSettings] = useState<SettingsData>({});
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [pairingCode, setPairingCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [pairingError, setPairingError] = useState("");
  const [saved, setSaved] = useState("");
  useEffect(() => {
    api<{ settings: SettingsData }>("/api/settings").then((d) =>
      setSettings(d.settings),
    );
    api<SyncStatus>("/api/sync/status").then(setSync);
  }, []);
  const save = async (key: keyof SettingsData) => {
    await api(`/api/settings/${key}`, {
      method: "PUT",
      body: JSON.stringify(settings[key] ?? {}),
    });
    setSaved(key);
    setTimeout(() => setSaved(""), 1800);
  };
  const pairWithCloud = async () => {
    setPairingError("");
    if (pairingCode.replace(/[^a-fA-F0-9]/g, "").length !== 16) {
      setPairingError("Enter the complete code shown in Cloud Admin.");
      return;
    }
    setPairing(true);
    try {
      await api("/api/setup/pair", {
        method: "POST",
        body: JSON.stringify({ pairingCode }),
      });
      window.location.reload();
    } catch (error) {
      setPairingError(error instanceof Error ? error.message : "Pairing failed");
      setPairing(false);
    }
  };
  return (
    <div className="content-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            {sync?.mode === "cloud" ? "Cloud configuration" : "Branch configuration"}
          </span>
          <h2>{t("settings")}</h2>
          <p>
            {sync?.mode === "cloud"
              ? "Administration and business defaults for the cloud service."
              : "Safe defaults for this local branch installation."}
          </p>
        </div>
      </div>
      <div className="settings-layout">
        <nav>
          <a href="#business" className="active">
            <Building2 /> Business
          </a>
          <a href="#tax">
            <ReceiptText /> Tax & receipt
          </a>
          <a href="#sync">
            <Cloud /> Cloud sync
          </a>
          <a href="#security">
            <ShieldCheck /> Security
          </a>
        </nav>
        <div className="settings-sections">
          <section className="panel settings-card" id="business">
            <header>
              <div>
                <span>
                  <Building2 />
                </span>
                <div>
                  <h3>Business identity</h3>
                  <p>Shown throughout Admin, POS, and printed receipts.</p>
                </div>
              </div>
            </header>
            <div className="settings-body">
              <label className="field">
                <span>Brand name</span>
                <input
                  value={settings.brand?.name ?? "Talk & TASTE"}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      brand: {
                        name: e.target.value,
                        currency: settings.brand?.currency ?? "EGP",
                        language: settings.brand?.language ?? "en",
                      },
                    })
                  }
                />
              </label>
              <div className="field-row">
                <label className="field">
                  <span>Primary currency</span>
                  <input value="Egyptian Pound — EGP" disabled />
                </label>
                <label className="field">
                  <span>Business timezone</span>
                  <input value="Africa/Cairo" disabled />
                </label>
              </div>
              <button className="primary-button" onClick={() => save("brand")}>
                <Save />{" "}
                {saved === "brand" ? "Saved" : "Save business settings"}
              </button>
            </div>
          </section>
          <section className="panel settings-card" id="tax">
            <header>
              <div>
                <span>
                  <ReceiptText />
                </span>
                <div>
                  <h3>Tax configuration</h3>
                  <p>
                    VAT is disabled by default and can be enabled when required.
                  </p>
                </div>
              </div>
            </header>
            <div className="settings-body">
              <fieldset className="settings-radio-group">
                <legend>{tr("VAT mode", "وضع ضريبة القيمة المضافة")}</legend>
                {[
                  { value: "disabled", label: tr("Disabled", "معطلة"), note: tr("No VAT is applied", "لا تُطبق ضريبة") },
                  { value: "inclusive", label: tr("VAT inclusive", "شاملة الضريبة"), note: tr("Menu prices already include VAT", "أسعار القائمة تشمل الضريبة") },
                  { value: "exclusive", label: tr("VAT exclusive", "غير شاملة الضريبة"), note: tr("VAT is added at checkout", "تُضاف الضريبة عند الدفع") },
                ].map((option) => {
                  const selected = !(settings.tax?.enabled ?? false)
                    ? "disabled"
                    : settings.tax?.pricesIncludeTax
                      ? "inclusive"
                      : "exclusive";
                  return (
                    <label className={selected === option.value ? "is-selected" : ""} key={option.value}>
                      <input
                        type="radio"
                        name="vat-mode"
                        value={option.value}
                        checked={selected === option.value}
                        onChange={() => setSettings({ ...settings, tax: {
                          enabled: option.value !== "disabled",
                          rate: settings.tax?.rate ?? 0,
                          pricesIncludeTax: option.value !== "exclusive",
                        } })}
                      />
                      <i />
                      <span><strong>{option.label}</strong><small>{option.note}</small></span>
                    </label>
                  );
                })}
              </fieldset>
              <div className="field-row">
                <label className="field">
                  <span>VAT rate (%)</span>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={settings.tax?.rate ?? 0}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        tax: {
                          enabled: settings.tax?.enabled ?? false,
                          rate: Number(e.target.value),
                          pricesIncludeTax:
                            settings.tax?.pricesIncludeTax ?? true,
                        },
                      })
                    }
                  />
                </label>
              </div>
              <button className="primary-button" onClick={() => save("tax")}>
                <Save /> {saved === "tax" ? "Saved" : "Save tax settings"}
              </button>
            </div>
          </section>
          <section className="panel settings-card" id="receipt">
            <header>
              <div>
                <span>
                  <ReceiptText />
                </span>
                <div>
                  <h3>Receipt & cash drawer</h3>
                  <p>English thermal receipt and cash-drawer behavior.</p>
                </div>
              </div>
            </header>
            <div className="settings-body">
              <div className="field-row">
                <label className="switch-field">
                  <input
                    type="checkbox"
                    checked={settings.receipt?.autoPrint ?? false}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        receipt: {
                          ...settings.receipt,
                          autoPrint: e.target.checked,
                        },
                      })
                    }
                  />
                  <i />
                  <div>
                    <strong>Auto-print after checkout</strong>
                    <small>
                      Prints silently on the dedicated Windows POS after a successful sale.
                    </small>
                  </div>
                </label>
                <label className="switch-field">
                  <input
                    type="checkbox"
                    checked={settings.receipt?.showBranch ?? true}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        receipt: {
                          ...settings.receipt,
                          showBranch: e.target.checked,
                        },
                      })
                    }
                  />
                  <i />
                  <div>
                    <strong>Show branch</strong>
                    <small>Include the English branch identity on each receipt.</small>
                  </div>
                </label>
              </div>
              <label className="field">
                <span>Drawer trigger</span>
                <select
                  value={settings.receipt?.drawerTrigger ?? "printer"}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      receipt: {
                        ...settings.receipt,
                        drawerTrigger: e.target.value,
                      },
                    })
                  }
                >
                  <option value="printer">Via receipt printer</option>
                  <option value="browser">Browser / local bridge</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>
              <button
                className="primary-button"
                onClick={() => save("receipt")}
              >
                <Save />{" "}
                {saved === "receipt" ? "Saved" : "Save receipt settings"}
              </button>
            </div>
          </section>
          <section className="panel settings-card" id="sync">
            <header>
              <div>
                <span>
                  <Cloud />
                </span>
                <div>
                  <h3>Cloud synchronization</h3>
                  <p>
                    Branch-local sales continue even when this service is
                    unavailable.
                  </p>
                </div>
              </div>
            </header>
            <div className="settings-body">
              {sync?.mode === "cloud" ? (
                <div className="config-note">
                  <ShieldCheck />
                  <div>
                    <strong>Cloud service online</strong>
                    <p>
                      This is the central administration service. Paired branch
                      devices upload their operational data here automatically.
                    </p>
                  </div>
                </div>
              ) : sync?.paired ? (
                <div className="config-note">
                  <ShieldCheck />
                  <div>
                    <strong>This installation is paired</strong>
                    <p>
                      {sync.pending
                        ? `${sync.pending} local changes are safely queued for upload.`
                        : "All queued branch data has been uploaded."}
                      {sync.failed
                        ? ` ${sync.failed} changes will retry automatically.`
                        : " Sync retries automatically whenever internet is available."}
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="config-note">
                    <Cloud />
                    <div>
                      <strong>Offline local mode</strong>
                      <p>
                        Sales and all other work stay safely on this computer.
                        You can operate for weeks, then pair once and upload the
                        complete queued history to its cloud branch.
                      </p>
                    </div>
                  </div>
                  <label className="field">
                    <span>One-time cloud pairing code</span>
                    <input
                      value={pairingCode}
                      onChange={(event) =>
                        setPairingCode(event.target.value.toUpperCase())
                      }
                      placeholder="XXXX-XXXX-XXXX-XXXX"
                      autoComplete="one-time-code"
                      spellCheck={false}
                    />
                    <small>Cloud Admin → Branches → Pair Windows Device</small>
                  </label>
                  {pairingError && <div className="form-error">{pairingError}</div>}
                  <button
                    className="primary-button"
                    onClick={() => void pairWithCloud()}
                    disabled={pairing}
                  >
                    <Link2 /> {pairing ? "Pairing…" : "Pair this installation"}
                  </button>
                </>
              )}
            </div>
          </section>
          <section className="panel settings-card" id="security">
            <header>
              <div>
                <span>
                  <ShieldCheck />
                </span>
                <div>
                  <h3>Security controls</h3>
                  <p>Enforced by the branch server for every request.</p>
                </div>
              </div>
            </header>
            <div className="settings-body">
              <div className="config-note">
                <ShieldCheck />
                <div>
                  <strong>Live permissions and immutable accountability</strong>
                  <p>
                    Staff deactivation and permission changes apply immediately.
                    Passwords and PINs are hashed, login attempts are
                    rate-limited, and sensitive actions are recorded in the
                    synchronized audit trail.
                  </p>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
