import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useNavigate } from "react-router-dom";
import { api, type UsersResponse, type UserDetailResponse } from "../api";
import "./Users.css";

export default function Users() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [hasReminders, setHasReminders] = useState(false);
  const [page, setPage] = useState(0);
  const limit = 20;

  const { data: listData, isLoading: listLoading, error: listError } = useQuery<UsersResponse>({
    queryKey: ["users", status, search, hasReminders, page],
    queryFn: () =>
      api(
        `/users?limit=${limit}&skip=${page * limit}${status ? `&status=${status}` : ""}${search ? `&search=${encodeURIComponent(search)}` : ""}${hasReminders ? "&hasReminders=true" : ""}`
      ),
    enabled: !id,
  });

  const { data: detailData, isLoading: detailLoading, error: detailError } = useQuery<UserDetailResponse>({
    queryKey: ["user", id],
    queryFn: () => api(`/users/${id}`),
    enabled: !!id,
  });

  if (id) {
    if (detailLoading) return <div className="page-loading">Loading user…</div>;
    if (detailError) return <div className="page-error">Error: {(detailError as Error).message}</div>;
    if (!detailData) return null;
    const { user, reminders, messageCount } = detailData;
    return (
      <div className="users-page">
        <button type="button" className="back-link" onClick={() => navigate("/users")}>
          ← Back to users
        </button>
        <h1>User detail</h1>
        <div className="detail-grid">
          <div className="detail-card">
            <h2>Profile</h2>
            <dl>
              <dt>ID</dt>
              <dd className="mono">{user.id ?? id}</dd>
              <dt>Phone</dt>
              <dd>{user.phone_number}</dd>
              <dt>Status</dt>
              <dd>{user.status}</dd>
              <dt>Timezone</dt>
              <dd>{user.timezone ?? "—"}</dd>
              <dt>Location</dt>
              <dd>{user.location ?? "—"}</dd>
              <dt>Gender</dt>
              <dd>{user.gender ?? "—"}</dd>
              <dt>Registered</dt>
              <dd>{user.created_at ? new Date(user.created_at).toLocaleString() : "—"}</dd>
              <dt>Messages sent</dt>
              <dd>{messageCount ?? 0}</dd>
            </dl>
          </div>
          <div className="detail-card">
            <h2>Reminders ({reminders.length})</h2>
            {reminders.length === 0 ? (
              <p className="muted">No reminders</p>
            ) : (
              <ul className="reminder-list">
                {reminders.map((r) => (
                  <li key={r.id ?? r.reminder_type}>
                    {r.id ? (
                      <Link to={`/reminders/${r.id}`} className="reminder-link">
                        <strong>{r.reminder_type}</strong> – {r.enabled ? "On" : "Off"} – offset {r.time_offset_minutes} min
                        {r.last_sent_at && ` · Last: ${new Date(r.last_sent_at).toLocaleString()}`}
                      </Link>
                    ) : (
                      <>
                        <strong>{r.reminder_type}</strong> – {r.enabled ? "On" : "Off"} – offset {r.time_offset_minutes} min
                        {r.last_sent_at && ` · Last: ${new Date(r.last_sent_at).toLocaleString()}`}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (listLoading) return <div className="page-loading">Loading users…</div>;
  if (listError) return <div className="page-error">Error: {(listError as Error).message}</div>;
  if (!listData) return null;

  const { users, total } = listData;
  const totalPages = Math.ceil(total / limit) || 1;

  return (
    <div className="users-page">
      <h1>Users</h1>
      <div className="filters">
        <input
          type="text"
          placeholder="Search phone"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setSearch(searchInput);
              setPage(0);
            }
          }}
        />
        <button
          type="button"
          className="search-btn"
          onClick={() => { setSearch(searchInput); setPage(0); }}
        >
          Search
        </button>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="pending">Pending</option>
        </select>
        <label className="filter-checkbox">
          <input
            type="checkbox"
            checked={hasReminders}
            onChange={(e) => { setHasReminders(e.target.checked); setPage(0); }}
          />
          Only with reminders
        </label>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Phone</th>
              <th>Status</th>
              <th>Timezone</th>
              <th>Location</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id ?? u.phone_number}>
                <td>{u.phone_number}</td>
                <td>{u.status}</td>
                <td>{u.timezone ?? "—"}</td>
                <td>{u.location ?? "—"}</td>
                <td>{u.created_at ? new Date(u.created_at).toLocaleDateString() : "—"}</td>
                <td>
                  <Link to={`/users/${u.id ?? u.phone_number}`}>View</Link>
                </td>
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
