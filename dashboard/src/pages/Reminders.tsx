import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type RemindersResponse } from "../api";
import "./Reminders.css";

export default function Reminders() {
  const [enabledFilter, setEnabledFilter] = useState<"" | "true" | "false">("");
  const [typeFilter, setTypeFilter] = useState("");
  const [page, setPage] = useState(0);
  const limit = 20;

  const { data, isLoading, error } = useQuery<RemindersResponse>({
    queryKey: ["reminders", enabledFilter, typeFilter, page],
    queryFn: () =>
      api(
        `/reminders?limit=${limit}&skip=${page * limit}${enabledFilter ? `&enabled=${enabledFilter}` : ""}${typeFilter ? `&reminderType=${typeFilter}` : ""}`
      ),
  });

  if (isLoading) return <div className="page-loading">Loading reminders…</div>;
  if (error) return <div className="page-error">Error: {(error as Error).message}</div>;
  if (!data) return null;

  const { reminders, total } = data;
  const totalPages = Math.ceil(total / limit) || 1;

  return (
    <div className="reminders-page">
      <h1>Reminders</h1>
      <div className="filters">
        <select value={enabledFilter} onChange={(e) => { setEnabledFilter(e.target.value as "" | "true" | "false"); setPage(0); }}>
          <option value="">All</option>
          <option value="true">Enabled</option>
          <option value="false">Disabled</option>
        </select>
        <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setPage(0); }}>
          <option value="">All types</option>
          <option value="tefillin">Tefillin</option>
          <option value="candle_lighting">Candle lighting</option>
          <option value="shema">Shema</option>
        </select>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>User (phone)</th>
              <th>Type</th>
              <th>Enabled</th>
              <th>Offset (min)</th>
              <th>Last sent</th>
              <th>Test time</th>
            </tr>
          </thead>
          <tbody>
            {reminders.map((r) => (
              <tr key={r.id}>
                <td>{r.user?.phone_number ?? r.user_id}</td>
                <td>{r.reminder_type}</td>
                <td>{r.enabled ? "Yes" : "No"}</td>
                <td>{r.time_offset_minutes}</td>
                <td>{r.last_sent_at ? new Date(r.last_sent_at).toLocaleString() : "—"}</td>
                <td>{r.test_time ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pagination">
        <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          Previous
        </button>
        <span>
          Page {page + 1} of {totalPages} ({total} total)
        </span>
        <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}
