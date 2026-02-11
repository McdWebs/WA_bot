export type ReminderType =
  | "tefillin"
  | "candle_lighting"
  | "shema"
  // Women's flows
  | "taara"
  | "clean_7";
export type Gender = "male" | "female" | "prefer_not_to_say";

export interface User {
  id?: string;
  phone_number: string;
  registered_at?: string;
  timezone?: string;
  location?: string;
  gender?: Gender;
  status: "active" | "inactive" | "pending";
  created_at?: string;
  updated_at?: string;
}

export interface ReminderSetting {
  id?: string;
  user_id: string;
  reminder_type: ReminderType;
  enabled: boolean;
  time_offset_minutes: number; // negative = before, positive = after
  test_time?: string; // TEST MODE ONLY: Manual test time in "HH:MM" format (e.g., "13:50")
  last_sent_at?: string; // ISO timestamp of when this reminder was last sent (prevents duplicates)
  /** For clean_7: start date (YYYY-MM-DD) in Israel timezone; used to compute "day N of 7" */
  clean_7_start_date?: string;
  created_at?: string;
  updated_at?: string;
}

export interface HebcalEvent {
  title: string;
  date: string;
  category: string;
  subcat?: string;
  hebrew?: string;
  memo?: string;
  yomtov?: boolean;
}

export interface HebcalResponse {
  title: string;
  date: string;
  location: {
    geo: string;
    city: string;
    tzid: string;
    latitude?: number;
    longitude?: number;
    title?: string;
    country?: string;
    elevation?: number;
  };
  items: HebcalEvent[];
}

export interface ZmanimResponse {
  date: string;
  location: {
    title: string;
    city: string;
    tzid: string;
    latitude: number;
    longitude: number;
    geo: string;
  };
  times: {
    sunset: string; // ISO format: "2025-12-09T16:35:00+02:00"
    [key: string]: string; // Other zmanim times
  };
}

export interface SunsetData {
  date: string;
  sunset: string;
  candle_lighting?: string;
  havdalah?: string;
}

export interface PrayerTime {
  name: string;
  time: string;
}

export interface MessageTemplate {
  id: string;
  name: string;
  content: string;
  reminder_type: ReminderType;
}
