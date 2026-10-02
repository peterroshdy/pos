import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Eye,
  EyeOff,
  LockKeyhole,
  UserRound,
} from "lucide-react";
import { useAuth } from "../auth";
import { useI18n } from "../i18n";
import { api } from "../api";

type LoginOption = {
  id: string;
  username: string;
  name: string;
  nameAr: string;
};

export function LoginPage() {
  const { login } = useAuth();
  const { language, setLanguage, t, tr } = useI18n();
  const [username, setUsername] = useState("admin");
  const [mode, setMode] = useState<"loading" | "branch" | "cloud">("loading");
  const [users, setUsers] = useState<LoginOption[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ mode: "branch" | "cloud"; users: LoginOption[] }>(
      "/api/auth/login-options",
    )
      .then((options) => {
        setMode(options.mode);
        setUsers(options.users);
      })
      .catch(() => setMode("cloud"));
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === "branch" && !selectedUserId) {
      setError(tr("Select your user name", "اختر اسم المستخدم"));
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      await login(
        mode === "branch" ? { userId: selectedUserId } : { username },
        password,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to sign in");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page login-page--simple">
      <section className="login-panel">
        <button
          className="language-toggle"
          onClick={() => setLanguage(language === "en" ? "ar" : "en")}
        >
          {t("language")}
        </button>
        <form
          className="login-form login-form--simple"
          onSubmit={submit}
          aria-label={tr("Sign in", "تسجيل الدخول")}
        >
          {mode === "branch" ? (
            <fieldset className="login-users">
              <legend>{tr("Select user", "اختر المستخدم")}</legend>
              <div className="login-users__list">
                {users.map((user) => (
                  <button
                    type="button"
                    className={selectedUserId === user.id ? "is-selected" : ""}
                    aria-pressed={selectedUserId === user.id}
                    key={user.id}
                    onClick={() => {
                      setSelectedUserId(user.id);
                      setError("");
                      requestAnimationFrame(() => passwordRef.current?.focus());
                    }}
                  >
                    <UserRound size={20} />
                    <span>{user.username}</span>
                  </button>
                ))}
              </div>
              {users.length === 0 && (
                <small>{tr("No active users", "لا يوجد مستخدمون نشطون")}</small>
              )}
            </fieldset>
          ) : (
            <label>
              <span>{tr("Username", "اسم المستخدم")}</span>
              <div className="input-wrap">
                <UserRound size={19} />
                <input
                  type="text"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  disabled={mode === "loading"}
                  autoComplete="username"
                />
              </div>
            </label>
          )}
          <label>
            <span>{t("password")}</span>
            <div className="input-wrap">
              <LockKeyhole size={19} />
              <input
                ref={passwordRef}
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </label>
          {error && <div className="form-error">{error}</div>}
          <button
            className="primary-button login-button"
            disabled={submitting || mode === "loading" || (mode === "branch" && users.length === 0)}
          >
            {submitting ? t("loggingIn") : t("signIn")}
            <ArrowRight size={19} />
          </button>
        </form>
      </section>
    </div>
  );
}
