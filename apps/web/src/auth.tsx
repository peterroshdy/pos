import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import type { Permission, SessionUser } from "@token-taste/shared";
import { api, login as loginRequest, sessionStore, type LoginCredentials } from "./api";

type AuthValue = {
  user: SessionUser | null;
  loading: boolean;
  setupRequired: boolean;
  setupRequiresPairing: boolean;
  completeOwnerSetup: (password: string, baristaPassword: string, pairingCode: string) => Promise<void>;
  login: (credentials: LoginCredentials, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (permission: Permission) => boolean;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupRequired, setSetupRequired] = useState(false);
  const [setupRequiresPairing, setSetupRequiresPairing] = useState(false);

  useEffect(() => {
    api<{ requiresOwnerSetup: boolean; requiresPairing: boolean }>("/api/setup/status")
      .then(async ({ requiresOwnerSetup, requiresPairing }) => {
        setSetupRequired(requiresOwnerSetup);
        setSetupRequiresPairing(requiresPairing);
        if (requiresOwnerSetup) {
          sessionStore.clear();
          return;
        }
        if (sessionStore.get()) {
          await api<SessionUser>("/api/session")
            .then(setUser)
            .catch(() => sessionStore.clear());
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const value = useMemo<AuthValue>(() => ({
    user,
    loading,
    setupRequired,
    setupRequiresPairing,
    completeOwnerSetup: async (password, baristaPassword, pairingCode) => {
      await api("/api/setup/owner", {
        method: "POST",
        body: JSON.stringify({
          password,
          confirmPassword: password,
          baristaPassword,
          pairingCode,
        }),
      });
      setSetupRequired(false);
      setUser(await loginRequest({ username: "admin" }, password));
    },
    login: async (credentials, password) => setUser(await loginRequest(credentials, password)),
    logout: async () => { try { await api("/api/auth/logout", { method: "POST" }); } finally { sessionStore.clear(); setUser(null); } },
    can: (permission) => Boolean(user?.permissions.includes(permission))
  }), [user, loading, setupRequired, setupRequiresPairing]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
