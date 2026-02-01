import { useQuery } from "@tanstack/react-query";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import { api, type Stats } from "../api";
import "./Overview.css";

// Softer, readable palette for dark background
const PIE_COLORS = ["#38bdf8", "#34d399", "#a78bfa", "#fbbf24", "#f472b6"];

export default function Overview() {
  const { data: stats, isLoading, error } = useQuery<Stats>({
    queryKey: ["stats"],
    queryFn: () => api("/stats"),
  });

  if (isLoading) return <div className="overview-loading">Loading stats…</div>;
  if (error) return <div className="overview-error">Error: {(error as Error).message}</div>;
  if (!stats) return null;

  const signupsData = stats.signupsOverTime || [];
  const remindersPie = Object.entries(stats.remindersByType || {}).map(([name, value]) => ({
    name: name === "tefillin" ? "Tefillin" : name === "candle_lighting" ? "Candle lighting" : name === "shema" ? "Shema" : name,
    value,
  }));

  return (
    <div className="overview">
      <h1>Overview</h1>
      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-label">Total users</span>
          <span className="kpi-value">{stats.usersTotal ?? 0}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Active users</span>
          <span className="kpi-value">{stats.usersByStatus?.active ?? 0}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Total reminders</span>
          <span className="kpi-value">{stats.remindersTotal ?? 0}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Active reminders</span>
          <span className="kpi-value">{stats.remindersEnabled ?? 0}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Messages today</span>
          <span className="kpi-value">{stats.messagesToday ?? "—"}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Messages this month</span>
          <span className="kpi-value">{stats.messagesThisMonth ?? "—"}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Cost today (USD)</span>
          <span className="kpi-value">
            {typeof stats.costToday === "number" ? stats.costToday.toFixed(4) : "—"}
          </span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Cost this month (USD)</span>
          <span className="kpi-value">
            {typeof stats.costThisMonth === "number" ? stats.costThisMonth.toFixed(4) : "—"}
          </span>
        </div>
      </div>
      <div className="charts-row">
        <div className="chart-card">
          <h2>Signups over time</h2>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={signupsData}>
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="count" fill="#4361ee" name="Signups" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-card">
          <h2>Reminders by type</h2>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie
                data={remindersPie}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={80}
                label
              >
                {remindersPie.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
