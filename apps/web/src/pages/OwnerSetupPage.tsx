import { useState, type FormEvent } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "../auth";
import { Brand } from "../components/Brand";
import { useI18n } from "../i18n";

export function OwnerSetupPage() {
  const { completeOwnerSetup, setupRequiresPairing } = useAuth();
  const { language, setLanguage, tr } = useI18n();
  const [password, setPassword] = useState("");
  const [baristaPassword, setBaristaPassword] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (password.length < 12) {
      setError(
        tr(
          "Use at least 12 characters.",
          "استخدم ١٢ حرفاً على الأقل.",
        ),
      );
      return;
    }
    if (password !== confirmation) {
      setError(tr("Passwords do not match.", "كلمتا المرور غير متطابقتين."));
      return;
    }
    if (baristaPassword.length < 10) {
      setError(tr("Use at least 10 characters for Barista.", "استخدم ١٠ أحرف على الأقل للباريستا."));
      return;
    }
    setSubmitting(true);
    try {
      await completeOwnerSetup(password, baristaPassword, pairingCode);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to finish setup");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page setup-page">
      <section className="login-visual">
        <div className="login-visual__grain" />
        <Brand />
        <div className="login-visual__content">
          <p className="eyebrow">
            {tr("Ready for this branch", "جاهز للعمل في هذا الفرع")}
          </p>
          <h1>
            {tr("One quick step.", "خطوة واحدة فقط.")}
            <br />
            <em>{tr("Choose your password.", "اختر كلمة المرور.")}</em>
          </h1>
          <p>
            {tr(
              "Choose the admin and Barista passwords now. Pair with a cloud branch now or later when internet is available.",
              "اختر كلمتي مرور المدير والباريستا الآن. يمكنك ربط فرع السحابة الآن أو لاحقاً عند توفر الإنترنت.",
            )}
          </p>
        </div>
        <div className="login-visual__features">
          <span>
            <CheckCircle2 size={18} />
            {tr("Cloud-owned branch identity", "هوية الفرع من السحابة")}
          </span>
          <span>
            <ShieldCheck size={18} />
            {tr("Credentials generated automatically", "بيانات الاعتماد تُنشأ تلقائياً")}
          </span>
        </div>
      </section>
      <section className="login-panel">
        <button
          className="language-toggle"
          onClick={() => setLanguage(language === "en" ? "ar" : "en")}
        >
          {language === "en" ? "العربية" : "English"}
        </button>
        <form className="login-form" onSubmit={submit}>
          <div className="login-form__mobile-brand">
            <Brand />
          </div>
          <span className="login-kicker">
            {tr("TALK & TASTE · FIRST START", "Talk & TASTE · التشغيل الأول")}
          </span>
          <h2>{tr("Create the two logins", "إنشاء حسابي الدخول")}</h2>
          <p>
            {tr(
              "Admin uses username admin. The POS user uses username Barista.",
              "يستخدم المدير اسم admin، ويستخدم موظف نقطة البيع اسم Barista.",
            )}
          </p>
          {setupRequiresPairing && (
            <label>
              <span>{tr("Cloud pairing code (optional)", "رمز ربط الفرع بالسحابة (اختياري)")}</span>
              <div className="input-wrap">
                <ShieldCheck size={19} />
                <input
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value.toUpperCase())}
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                  autoComplete="one-time-code"
                  spellCheck={false}
                />
              </div>
              <small className="setup-field-hint">
                {tr(
                  "Cloud Admin → Branches → Pair Windows Device",
                  "لوحة السحابة ← الفروع ← ربط جهاز ويندوز",
                )}
                {" · "}
                {tr(
                  "Leave blank to start offline and pair later in Settings.",
                  "اتركه فارغاً للعمل دون إنترنت والربط لاحقاً من الإعدادات.",
                )}
              </small>
            </label>
          )}
          <label>
            <span>{tr("Admin password", "كلمة مرور المدير")}</span>
            <div className="input-wrap">
              <LockKeyhole size={19} />
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                autoFocus
                required
              />
              <button
                type="button"
                aria-label={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </label>
          <label>
            <span>{tr("Barista password", "كلمة مرور الباريستا")}</span>
            <div className="input-wrap">
              <LockKeyhole size={19} />
              <input
                type={showPassword ? "text" : "password"}
                value={baristaPassword}
                onChange={(event) => setBaristaPassword(event.target.value)}
                minLength={10}
                maxLength={128}
                autoComplete="new-password"
                required
              />
            </div>
          </label>
          <label>
            <span>{tr("Confirm password", "تأكيد كلمة المرور")}</span>
            <div className="input-wrap">
              <LockKeyhole size={19} />
              <input
                type={showPassword ? "text" : "password"}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                required
              />
            </div>
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button login-button" disabled={submitting}>
            {submitting
              ? tr("Finishing setup…", "جارٍ إكمال الإعداد…")
              : tr("Finish and sign in", "إكمال وتسجيل الدخول")}
            <ArrowRight size={19} />
          </button>
          <small className="credential-hint">
            {tr(
              "All other setup values were generated automatically.",
              "تم إنشاء جميع قيم الإعداد الأخرى تلقائياً.",
            )}
          </small>
        </form>
        <footer>© 2026 Talk &amp; TASTE</footer>
      </section>
    </div>
  );
}
