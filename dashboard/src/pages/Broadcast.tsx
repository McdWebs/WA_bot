import { useState } from "react";
import { api } from "../api";
import "./Broadcast.css";

interface BroadcastResult {
  status?: string;
  message?: string;
  sent?: number;
  failed?: number;
  total: number;
}

export default function Broadcast() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BroadcastResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    if (!confirm("לשלוח את תבנית contribution לכל המשתמשים?")) return;
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const data = await api<BroadcastResult>("/broadcast", { method: "POST" });
      setResult(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="broadcast">
      <h1>Broadcast</h1>

      <div className="broadcast-card">
        <div className="broadcast-template-name">contribution</div>
        <p className="broadcast-desc">שליחת התבנית לכל המשתמשים הרשומים במערכת.</p>
        <button
          className="broadcast-btn"
          onClick={handleSend}
          disabled={loading}
        >
          {loading ? "שולח..." : "שלח לכולם"}
        </button>
      </div>

      {result && (
        <div className="broadcast-result success">
          {result.status === "started" ? (
            <span>✅ שליחה התחילה ברקע — {result.total} משתמשים. ההודעות נשלחות בהדרגה (כ-1 שנייה בין כל הודעה).</span>
          ) : (
            <>
              <span>נשלח: {result.sent}</span>
              <span>נכשל: {result.failed}</span>
              <span>סה"כ: {result.total}</span>
            </>
          )}
        </div>
      )}

      {error && (
        <div className="broadcast-result error">
          שגיאה: {error}
        </div>
      )}
    </div>
  );
}
