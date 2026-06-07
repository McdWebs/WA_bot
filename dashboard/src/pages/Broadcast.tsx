import { useState } from "react";
import { api } from "../api";
import "./Broadcast.css";

interface BroadcastBatch {
  name: string;
  total: number;
  skipped: number;
  submitted: number;
  failed: number;
  remaining: number;
  delivered: number;
  sent: number;
  undelivered: number;
}

interface BroadcastResult {
  campaign: string;
  total: number;
  skipped: number;
  submitted: number;
  failed: number;
  remaining: number;
  capReached: boolean;
  maxPerRun: number;
  delivered: number;
  sent: number;
  undelivered: number;
  deliveryPending?: boolean;
  batches: BroadcastBatch[];
}

const BATCH_LABELS: Record<string, string> = {
  with_reminders: "מנה 1 · משתמשים עם תזכורות",
  without_reminders: "מנה 2 · שאר המשתמשים",
};

export default function Broadcast() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BroadcastResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    if (
      !confirm(
        "לשלוח את תבנית contribution?\n\nהשליחה מתבצעת בשתי מנות: קודם המשתמשים עם תזכורות, ואז שאר המשתמשים. מי שכבר קיבל את ההודעה יידלג (אפשר להריץ שוב כדי להשלים). השליחה הדרגתית ועשויה לקחת כמה דקות — אל תסגור את הדף."
      )
    ) {
      return;
    }
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
        <p className="broadcast-desc">
          שליחה בשתי מנות: <strong>מנה 1</strong> — משתמשים עם תזכורות, ואז{" "}
          <strong>מנה 2</strong> — שאר המשתמשים. מי שכבר קיבל את ההודעה נדלג (אפשר
          להריץ שוב מחר כדי להשלים את מי שנכשל/נחסם). השליחה מפוזרת (~2 שניות בין
          הודעות) כדי למנוע שגיאת rate limit ב-Twilio.
        </p>
        <button className="broadcast-btn" onClick={handleSend} disabled={loading}>
          {loading ? "שולח ובודק מסירה... (אל תסגור)" : "שלח לכולם (2 מנות)"}
        </button>
      </div>

      {result && (
        <div className="broadcast-results">
          {result.batches.map((b) => (
            <div key={b.name} className="broadcast-batch">
              <div className="broadcast-batch-title">
                {BATCH_LABELS[b.name] ?? b.name}
                <span className="broadcast-batch-total">{b.total} משתמשים</span>
              </div>
              <div className="broadcast-batch-stats">
                <span className="broadcast-chip success">נמסרו {b.delivered}</span>
                <span className="broadcast-chip sent">במסלול {b.sent}</span>
                <span className="broadcast-chip undelivered">
                  לא נמסרו {b.undelivered}
                </span>
                <span className="broadcast-chip failed">נכשלו {b.failed}</span>
                <span className="broadcast-chip skipped">דולגו {b.skipped}</span>
                {b.remaining > 0 && (
                  <span className="broadcast-chip remaining">
                    נותרו {b.remaining}
                  </span>
                )}
              </div>
            </div>
          ))}

          <div className="broadcast-result summary">
            <span className="broadcast-stat-label">סה"כ נמסרו</span>
            <span className="broadcast-stat-value">{result.delivered}</span>
            <span className="broadcast-stat-label">נשלחו בריצה</span>
            <span className="broadcast-stat-value">{result.submitted}</span>
            <span className="broadcast-stat-label">דולגו (כבר קיבלו)</span>
            <span className="broadcast-stat-value">{result.skipped}</span>
            <span className="broadcast-stat-label">סה"כ משתמשים</span>
            <span className="broadcast-stat-value">{result.total}</span>
          </div>

          {result.capReached && (
            <p className="broadcast-pending-note">
              הגעת למכסת השליחה לריצה ({result.maxPerRun}). נותרו {result.remaining}{" "}
              משתמשים — הרץ שוב מחר כדי להמשיך מאיפה שנעצרת.
            </p>
          )}
          {!result.capReached && result.remaining > 0 && (
            <p className="broadcast-pending-note">
              נותרו {result.remaining} משתמשים שלא נשלחו. הרץ שוב כדי להשלים אותם.
            </p>
          )}
          {result.deliveryPending && (
            <p className="broadcast-pending-note">
              חלק מההודעות עדיין במסלול אחרי זמן ההמתנה. בדוק שוב ב-Twilio Console
              בעוד כמה דקות.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="broadcast-result error">שגיאה: {error}</div>
      )}
    </div>
  );
}
