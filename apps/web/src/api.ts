import type { SessionUser } from "@token-taste/shared";
import { translateArabic } from "./ui-arabic";

const TOKEN_KEY = "token-taste-session";

export const sessionStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = sessionStore.get();
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...options, headers });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    const rawMessage = data.error ?? "Something went wrong";
    const message = localStorage.getItem("token-taste-language") === "ar"
      ? translateArabic(rawMessage)
      : rawMessage;
    window.dispatchEvent(
      new CustomEvent("token-taste-api-error", { detail: message }),
    );
    if (response.status === 401 && token) {
      sessionStore.clear();
      if (window.location.pathname !== "/login")
        window.location.assign("/login");
    }
    throw new ApiError(message, response.status, data);
  }
  return data as T;
}

export type LoginCredentials = { username: string } | { userId: string };

export async function login(credentials: LoginCredentials, password: string) {
  const data = await api<{ token: string; user: SessionUser }>(
    "/api/auth/login",
    {
      method: "POST",
      body: JSON.stringify({ ...credentials, password }),
    },
  );
  sessionStore.set(data.token);
  return data.user;
}
