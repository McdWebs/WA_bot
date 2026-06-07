import { useCallback, useEffect, useRef, useState } from "react";
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

interface BroadcastProgress {
  status: "idle" | "running" | "completed" | "error";
  phase: "idle" | "sending" | "polling" | "done" | "error";
  campaign: string;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  skipped: number;
  toSend: number;
  submitted: number;
  failed: number;
  remaining: number;
  capReached: boolean;
  maxPerRun: number;
  delivered: number;
  sent: number;
  undelivered: number;
  deliveryPending: boolean;
  batches: BroadcastBatch[];
  error: string | null;
}

interface StartResponse {
  started: boolean;
  alreadyRunning?: boolean;
  progress: BroadcastProgress;
}

const BATCH_LABELS: Record<string, string> = {
  with_reminders: "מנה 1 · משתמשים עם תזכורות",
  without_reminders: "מנה 2 · שאר המשתמשים",
};

const PHASE_LABELS: Record<BroadcastProgress["phase"], string> = {
  idle: "ממתין",
  sending: "שולח הודעות...",
  polling: "בודק מסירה ב-Twilio...",
  done: "הסתיים",
  error: "שגיאה",
};

export default function Broadcast() {
  const [progress, setProgress] = useState<BroadcastProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<number | null>(null);

  const isRunning = progress?.status === "running";

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      const data = await api<BroadcastProgress>("/broadcast/status");
      setProgress(data);
      if (data.status !== "running") {
        stopPolling();
      }
    } catch (err) {
      // Transient network hiccup during a long run shouldn't kill the UI; keep polling.
      console.warn("broadcast status poll failed", err);
    }
  }, [stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    poll();
    pollRef.current = window.setInterval(poll, 2500);
  }, [poll, stopPolling]);

  // On mount: check whether a run is already in progress (e.g. after a page refresh).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<BroadcastProgress>("/broadcast/status");
        if (cancelled) return;
        setProgress(data);
        if (data.status === "running") startPolling();
      } catch {
        /* not authenticated yet / no run – ignore */
      }
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [startPolling, stopPolling]);

  async function handleSend() {
    if (
      !confirm(
        "לשלוח את תבנית contribution?\n\nהשליחה רצה ברקע בשתי מנות: קודם המשתמשים עם תזכורות, ואז שאר המשתמשים. מי שכבר קיבל את ההודעה יידלג. אפשר לעקוב אחרי ההתקדמות כאן (גם אם תסגור ותחזור)."
      )
    ) {
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const data = await api<StartResponse>("/broadcast", { method: "POST" });
      setProgress(data.progress);
      startPolling();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  const attempted = progress ? progress.submitted + progress.failed : 0;
  const pct =
    progress && progress.toSend > 0
      ? Math.min(100, Math.round((attempted / progress.toSend) * 100))
      : progress?.status === "completed"
      ? 100
      : 0;

  return (
    <div className="broadcast">
      <h1>Broadcast</h1>

      <div className="broadcast-card">
        <div className="broadcast-template-name">contribution</div>
        <p className="broadcast-desc">
          שליחה ברקע בשתי מנות: <strong>מנה 1</strong> — משתמשים עם תזכורות, ואז{" "}
          <strong>מנה 2</strong> — שאר המשתמשים. מי שכבר קיבל את ההודעה נדלג (הרץ
          שוב מחר כדי להשלים את מי שנכשל/נחסם). השליחה מפוזרת (~2 שניות בין הודעות)
          כדי למנוע שגיאת rate limit ב-Twilio.
        </p>
        <button
          className="broadcast-btn"
          onClick={handleSend}
          disabled={starting || isRunning}
        >
          {isRunning
            ? "השליחה רצה ברקע..."
            : starting
            ? "מתחיל..."
            : "שלח לכולם (2 מנות)"}
        </button>
      </div>

      {progress && progress.status !== "idle" && (
        <div className="broadcast-results">
          {/* Live progress header */}
          <div className="broadcast-progress">
            <div className="broadcast-progress-head">
              <span className={`broadcast-phase ${progress.status}`}>
                {isRunning && <span className="broadcast-spinner" />}
                {PHASE_LABELS[progress.phase]}
              </span>
              <span className="broadcast-progress-count">
                {attempted} / {progress.toSend} נשלחו
              </span>
            </div>
            <div className="broadcast-progress-bar">
              <div
                className={`broadcast-progress-fill ${progress.status}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          {/* Per-batch breakdown */}
          {progress.batches.map((b) => (
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

          {/* Totals */}
          <div className="broadcast-result summary">
            <span className="broadcast-stat-label">נשלחו בריצה</span>
            <span className="broadcast-stat-value">{progress.submitted}</span>
            <span className="broadcast-stat-label">נמסרו</span>
            <span className="broadcast-stat-value">{progress.delivered}</span>
            <span className="broadcast-stat-label">דולגו (כבר קיבלו)</span>
            <span className="broadcast-stat-value">{progress.skipped}</span>
            <span className="broadcast-stat-label">סה"כ משתמשים</span>
            <span className="broadcast-stat-value">{progress.total}</span>
          </div>

          {progress.status === "error" && (
            <p className="broadcast-pending-note error-note">
              השליחה נכשלה: {progress.error}
            </p>
          )}
          {progress.status === "completed" && progress.capReached && (
            <p className="broadcast-pending-note">
              הגעת למכסת השליחה לריצה ({progress.maxPerRun}). נותרו{" "}
              {progress.remaining} משתמשים — הרץ שוב מחר כדי להמשיך מאיפה שנעצרת.
            </p>
          )}
          {progress.status === "completed" &&
            !progress.capReached &&
            progress.remaining > 0 && (
              <p className="broadcast-pending-note">
                נותרו {progress.remaining} משתמשים שלא נשלחו. הרץ שוב כדי להשלים.
              </p>
            )}
          {progress.status === "completed" && progress.deliveryPending && (
            <p className="broadcast-pending-note">
              חלק מההודעות עדיין במסלול. בדוק שוב ב-Twilio Console בעוד כמה דקות.
            </p>
          )}
        </div>
      )}

      {error && <div className="broadcast-result error">שגיאה: {error}</div>}
    </div>
  );
}
