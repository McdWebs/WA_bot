/**
 * Seven clean days (שבעה נקיים): `clean_7_start_date` is the first day of the count (day 1).
 * Uses noon UTC anchors so Israel calendar dates don't shift at DST boundaries.
 */
export function clean7DaysSinceStart(
  startDateYYYYMMDD: string,
  todayYYYYMMDD: string
): number {
  const start = new Date(startDateYYYYMMDD + "T12:00:00Z").getTime();
  const today = new Date(todayYYYYMMDD + "T12:00:00Z").getTime();
  return Math.floor((today - start) / (24 * 60 * 60 * 1000));
}

/** Current day of the seven-day count (1–7). Start date = day 1. */
export function clean7CurrentDayNumber(
  startDateYYYYMMDD: string,
  todayYYYYMMDD: string
): number {
  return clean7DaysSinceStart(startDateYYYYMMDD, todayYYYYMMDD) + 1;
}

export function isWithinClean7Window(
  startDateYYYYMMDD: string,
  todayYYYYMMDD: string
): boolean {
  const idx = clean7DaysSinceStart(startDateYYYYMMDD, todayYYYYMMDD);
  return idx >= 0 && idx <= 6;
}

/**
 * Full Hebrew line for the WhatsApp template variable.
 * Template should render {{1}} as this string (e.g. body = "{{1}}" only).
 */
export function buildClean7ReminderText(dayToday: number): string {
  if (dayToday < 1 || dayToday > 7) {
    return "";
  }
  const head = `היום זה יום ${dayToday} מתוך ספירת שבעה נקיים`;
  if (dayToday >= 7) {
    return `${head}.`;
  }
  const next = dayToday + 1;
  return `${head}. מחר זה יום ${next} מתוך ספירת שבעה נקיים.`;
}
