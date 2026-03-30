/**
 * Returns HH:MM for (time - minutes). time is "HH:MM".
 */
export function subtractMinutesFromTime(time: string, minutes: number): string {
  const m = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return "18:00";
  let h = parseInt(m[1], 10);
  let min = parseInt(m[2], 10);
  let total = h * 60 + min - minutes;
  if (total < 0) total += 24 * 60;
  const nh = Math.floor(total / 60) % 24;
  const nm = total % 60;
  return `${nh.toString().padStart(2, "0")}:${nm.toString().padStart(2, "0")}`;
}

/**
 * Parses "HH:MM" into minutes from midnight.
 * Falls back to 0 if parsing fails.
 */
export function parseTimeOfDayToMinutes(timeOfDay: string | null): number {
  if (!timeOfDay) return 0;
  const match = timeOfDay.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return 0;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return 0;
  return hours * 60 + minutes;
}
