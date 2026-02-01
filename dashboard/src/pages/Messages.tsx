import { useQuery } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { api, type MessagesResponse } from "../api";
import "./Messages.css";

export default function Messages() {
  const { data, isLoading, error } = useQuery<MessagesResponse>({
    queryKey: ["messages"],
    queryFn: () => api("/messages"),
  });

  if (isLoading) return <div className="page-loading">Loading messages…</div>;
  if (error) return <div className="page-error">Error: {(error as Error).message}</div>;
  if (!data) return null;

  const isEmpty = data.total === 0 && (!data.recent || data.recent.length === 0);

  return (
    <div className="messages-page">
      <h1>Messages</h1>
      {isEmpty && (
        <p className="messages-empty-state">
          No messages logged yet. Messages are recorded when the bot sends a WhatsApp message (reminders, menu, templates, etc.). Use the bot to trigger a message, then refresh this page.
        </p>
      )}
      <div className="kpi-row">
        <div className="kpi-card">
          <span className="kpi-label">Total (logged)</span>
          <span className="kpi-value">{data.total}</span>
        </div>
        {Object.entries(data.byType || {}).map(([type, count]) => (
          <div key={type} className="kpi-card">
            <span className="kpi-label">{type}</span>
            <span className="kpi-value">{count}</span>
          </div>
        ))}
      </div>
      {data.byDay && data.byDay.length > 0 && (
        <div className="chart-card">
          <h2>Messages by day</h2>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={data.byDay}>
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="count" fill="#4361ee" name="Messages" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {data.recent && data.recent.length > 0 && (
        <div className="recent-section">
          <h2>Recent messages</h2>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Phone</th>
                  <th>Type</th>
                  <th>Template</th>
                  <th>Sent</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((m) => (
                  <tr key={m.twilio_sid}>
                    <td>{m.phone_number}</td>
                    <td>{m.type}</td>
                    <td>{m.template_key ?? "—"}</td>
                    <td>{new Date(m.sent_at).toLocaleString()}</td>
                    <td>{m.status ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
