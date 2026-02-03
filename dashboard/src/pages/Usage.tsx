import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type UsageForRangeResponse } from "../api";
import "./Usage.css";

type Period = "this-month" | "last-month" | string; // string = "YYYY-MM" for past months

function getMonthOptions(): { value: Period; label: string }[] {
  const options: { value: Period; label: string }[] = [
    { value: "this-month", label: "This month" },
    { value: "last-month", label: "Last month" },
  ];
  const now = new Date();
  for (let i = 2; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const monthName = d.toLocaleString("default", { month: "long", year: "numeric" });
    options.push({ value: `${y}-${m}`, label: monthName });
  }
  return options;
}

function getRangeForPeriod(period: Period): { startDate: string; endDate: string } | null {
  const now = new Date();
  if (period === "this-month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return {
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    };
  }
  if (period === "last-month") {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return {
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    };
  }
  if (/^\d{4}-\d{2}$/.test(period)) {
    const [y, m] = period.split("-").map(Number);
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 0);
    return {
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    };
  }
  return null;
}

export default function Usage() {
  const [period, setPeriod] = useState<Period>("this-month");
  const monthOptions = useMemo(() => getMonthOptions(), []);

  const range = getRangeForPeriod(period);

  const { data: rangeData, isLoading } = useQuery<UsageForRangeResponse>({
    queryKey: ["usage-range", range?.startDate, range?.endDate],
    queryFn: () =>
      api(
        `/usage?startDate=${range!.startDate}&endDate=${range!.endDate}`
      ),
    enabled: !!range,
  });

  const periodLabel = monthOptions.find((o) => o.value === period)?.label ?? period;
  const totalPrice = rangeData?.totalPrice ?? 0;
  const totalCount = rangeData?.totalCount ?? 0;
  const breakdown = rangeData?.breakdown ?? [];

  if (isLoading) return <div className="page-loading">Loading usage…</div>;

  return (
    <div className="usage-page">
      <h1>Cost & Usage</h1>

      <div className="usage-period-select">
        <label htmlFor="usage-period">Period</label>
        <select
          id="usage-period"
          value={period}
          onChange={(e) => setPeriod(e.target.value as Period)}
        >
          {monthOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="usage-hero">
        <div className="usage-hero-label">{periodLabel}</div>
        <div className="usage-hero-cost">${totalPrice.toFixed(2)} USD</div>
        <div className="usage-hero-count">{totalCount.toLocaleString()} usage units</div>
      </div>

      {breakdown.length > 0 && (
        <div className="usage-breakdown">
          <h2>Breakdown</h2>
          <ul className="usage-breakdown-list">
            {breakdown.map((b) => (
              <li key={b.label}>
                <span className="usage-breakdown-label">{b.label}</span>
                <span className="usage-breakdown-price">${b.price.toFixed(2)}</span>
                {b.count > 0 && (
                  <span className="usage-breakdown-count">({b.count.toLocaleString()} units)</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="usage-cached">Data cached ~10 min</p>
    </div>
  );
}
