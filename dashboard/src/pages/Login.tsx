import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { api, setToken, clearToken } from "../api";
import "./Login.css";

export default function Login() {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname || "/";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      setToken(apiKey);
      await api("/stats");
      login(apiKey);
      navigate(from, { replace: true });
    } catch (err) {
      clearToken();
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Dashboard</h1>
        <p className="login-subtitle">WhatsApp Reminders Bot</p>
        <form onSubmit={handleSubmit}>
          <label>
            API Key
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="DASHBOARD_API_KEY"
              required
              autoFocus
            />
          </label>
          {error && <p className="login-error">{error}</p>}
          <button type="submit" disabled={loading}>
            {loading ? "Checking…" : "Log in"}
          </button>
        </form>
      </div>
    </div>
  );
}
