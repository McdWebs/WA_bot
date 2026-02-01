import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

type AuthContextValue = {
  isAuthenticated: boolean;
  login: (apiKey: string) => void;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = "dashboard_api_key";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!sessionStorage.getItem(STORAGE_KEY));

  const login = useCallback((apiKey: string) => {
    sessionStorage.setItem(STORAGE_KEY, apiKey);
    setIsAuthenticated(true);
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY);
    setIsAuthenticated(false);
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
