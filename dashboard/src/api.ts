const LOCAL_BACKEND = "http://localhost:3000/api/dashboard";

function getApiBase(): string {
  if (typeof window !== "undefined") {
    const origin = window.location.origin;
    if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
      return LOCAL_BACKEND;
    }
  }
  if (import.meta.env.DEV) return "/api/dashboard";
  return import.meta.env.VITE_API_BASE_URL
    ? `${String(import.meta.env.VITE_API_BASE_URL).replace(/\/$/, "")}/api/dashboard`
    : "/api/dashboard";
}

function getToken(): string | null {
  return sessionStorage.getItem("dashboard_api_key");
}

export function setToken(token: string): void {
  sessionStorage.setItem("dashboard_api_key", token);
}

export function clearToken(): void {
  sessionStorage.removeItem("dashboard_api_key");
}

export async function api<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const token = getToken();
  if (!token) {
    throw new Error("Not authenticated");
  }
  const res = await fetch(`${getApiBase()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (res.status === 401) {
    clearToken();
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || "Request failed");
  }
  return res.json();
}

export interface Stats {
  usersByStatus: Record<string, number>;
  usersTotal: number;
  remindersByType: Record<string, number>;
  remindersTotal: number;
  remindersEnabled: number;
  signupsOverTime: { date: string; count: number }[];
  messagesToday?: number;
  messagesThisMonth?: number;
  costToday?: number;
  costThisMonth?: number;
  usageCached?: boolean;
  databaseUnavailable?: boolean;
}

export interface User {
  id?: string;
  phone_number: string;
  status: string;
  timezone?: string;
  location?: string;
  gender?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ReminderSetting {
  id?: string;
  user_id: string;
  reminder_type: string;
  enabled: boolean;
  time_offset_minutes: number;
  last_sent_at?: string;
  test_time?: string;
  created_at?: string;
  updated_at?: string;
  user?: User;
}

export interface UsersResponse {
  users: User[];
  total: number;
}

export interface UserDetailResponse {
  user: User;
  reminders: ReminderSetting[];
  messageCount: number;
}

export interface RemindersResponse {
  reminders: (ReminderSetting & { user?: User })[];
  total: number;
}

export interface MessagesResponse {
  total: number;
  byDay: { date: string; count: number }[];
  byType: Record<string, number>;
  recent: Array<{
    phone_number: string;
    twilio_sid: string;
    type: string;
    template_key?: string;
    sent_at: string;
    status?: string;
  }>;
}

export interface UsageResponse {
  today: { count: number; price: number; records: Array<{ category: string; count: string; price: number }> };
  thisMonth: { count: number; price: number; records: Array<{ category: string; count: string; price: number }> };
  cached?: boolean;
}

export interface UsageForRangeResponse {
  totalPrice: number;
  totalCount: number;
  breakdown: Array<{ label: string; price: number; count: number }>;
}
