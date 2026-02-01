import { useQuery } from "@tanstack/react-query";
import { api, type UsageResponse } from "../api";
import "./Usage.css";

export default function Usage() {
  const { data, isLoading, error } = useQuery<UsageResponse>({
    queryKey: ["usage"],
    queryFn: () => api("/usage"),
  });

  if (isLoading) return <div className="page-loading">Loading usage…</div>;
  if (error) return <div className="page-error">Error: {(error as Error).message}</div>;
  if (!data) return null;

  return (
    <div className="usage-page">
      <h1>Cost & Usage</h1>
      {data.cached && <p className="cached-badge">Cached (refreshes every ~10 min)</p>}
      <div className="usage-grid">
        <div className="usage-card">
          <h2>Today</h2>
          <p className="usage-count">Count: {data.today.count}</p>
          <p className="usage-price">Price: ${data.today.price.toFixed(4)} USD</p>
          {data.today.records.length > 0 && (
            <div className="usage-records">
              <h3>By category</h3>
              <ul>
                {data.today.records.map((r) => (
                  <li key={r.category}>
                    {r.category}: {r.count} · ${r.price.toFixed(4)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="usage-card">
          <h2>This month</h2>
          <p className="usage-count">Count: {data.thisMonth.count}</p>
          <p className="usage-price">Price: ${data.thisMonth.price.toFixed(4)} USD</p>
          {data.thisMonth.records.length > 0 && (
            <div className="usage-records">
              <h3>By category</h3>
              <ul>
                {data.thisMonth.records.map((r) => (
                  <li key={r.category}>
                    {r.category}: {r.count} · ${r.price.toFixed(4)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
