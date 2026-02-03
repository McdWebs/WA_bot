import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type ReminderSetting } from "../api";
import "./ReminderDetail.css";

type ReminderWithUser = ReminderSetting & { user?: { id?: string; phone_number: string } };

export default function ReminderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [formEnabled, setFormEnabled] = useState(true);
  const [formOffset, setFormOffset] = useState(0);
  const [formTestTime, setFormTestTime] = useState("");

  const { data: reminder, isLoading, error } = useQuery<ReminderWithUser>({
    queryKey: ["reminder", id],
    queryFn: () => api(`/reminders/${id}`),
    enabled: !!id,
  });

  const patchMutation = useMutation({
    mutationFn: (body: { enabled?: boolean; time_offset_minutes?: number; test_time?: string }) =>
      api(`/reminders/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }) as Promise<ReminderWithUser>,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reminder", id] });
      queryClient.invalidateQueries({ queryKey: ["user", reminder?.user?.id] });
      queryClient.invalidateQueries({ queryKey: ["reminders"] });
      setEditing(false);
    },
  });

  useEffect(() => {
    if (reminder) {
      setFormEnabled(reminder.enabled);
      setFormOffset(reminder.time_offset_minutes);
      setFormTestTime(reminder.test_time ?? "");
    }
  }, [reminder]);

  if (!id) {
    navigate("/reminders");
    return null;
  }
  if (isLoading) return <div className="page-loading">Loading reminder…</div>;
  if (error) return <div className="page-error">Error: {(error as Error).message}</div>;
  if (!reminder) return null;

  const handleSave = () => {
    patchMutation.mutate({
      enabled: formEnabled,
      time_offset_minutes: formOffset,
      test_time: formTestTime || undefined,
    });
  };

  return (
    <div className="reminder-detail-page">
      <button type="button" className="back-link" onClick={() => navigate(-1)}>
        ← Back
      </button>
      <h1>Reminder</h1>
      <div className="reminder-detail-grid">
        <div className="detail-card">
          <h2>Details</h2>
          <dl>
            <dt>Type</dt>
            <dd>{reminder.reminder_type}</dd>
            <dt>Enabled</dt>
            <dd>{reminder.enabled ? "Yes" : "No"}</dd>
            <dt>Time offset (minutes)</dt>
            <dd>{reminder.time_offset_minutes}</dd>
            <dt>Test time</dt>
            <dd>{reminder.test_time ?? "—"}</dd>
            <dt>Last sent</dt>
            <dd>{reminder.last_sent_at ? new Date(reminder.last_sent_at).toLocaleString() : "—"}</dd>
            {reminder.user && (
              <>
                <dt>User</dt>
                <dd>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => navigate(`/users/${reminder.user?.id ?? reminder.user_id}`)}
                  >
                    {reminder.user.phone_number}
                  </button>
                </dd>
              </>
            )}
          </dl>
        </div>
        <div className="detail-card">
          <h2>Edit</h2>
          {!editing ? (
            <button type="button" className="edit-btn" onClick={() => setEditing(true)}>
              Edit reminder
            </button>
          ) : (
            <div className="edit-form">
              <label className="edit-row">
                <span>Enabled</span>
                <input
                  type="checkbox"
                  checked={formEnabled}
                  onChange={(e) => setFormEnabled(e.target.checked)}
                />
              </label>
              <label className="edit-row">
                <span>Time offset (minutes)</span>
                <input
                  type="number"
                  value={formOffset}
                  onChange={(e) => setFormOffset(Number(e.target.value))}
                />
              </label>
              <label className="edit-row">
                <span>Test time (HH:MM optional)</span>
                <input
                  type="text"
                  placeholder="e.g. 14:30"
                  value={formTestTime}
                  onChange={(e) => setFormTestTime(e.target.value)}
                />
              </label>
              <div className="edit-actions">
                <button
                  type="button"
                  className="save-btn"
                  onClick={handleSave}
                  disabled={patchMutation.isPending}
                >
                  {patchMutation.isPending ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className="cancel-btn"
                  onClick={() => {
                    setEditing(false);
                    if (reminder) {
                      setFormEnabled(reminder.enabled);
                      setFormOffset(reminder.time_offset_minutes);
                      setFormTestTime(reminder.test_time ?? "");
                    }
                  }}
                  disabled={patchMutation.isPending}
                >
                  Cancel
                </button>
              </div>
              {patchMutation.isError && (
                <p className="form-error">{(patchMutation.error as Error).message}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
