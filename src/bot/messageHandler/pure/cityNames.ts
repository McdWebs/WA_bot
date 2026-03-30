/**
 * Converts English city name to Hebrew
 */
export function getCityNameInHebrew(city: string | null): string {
  if (!city) return "לא צוין";

  const cityMap: Record<string, string> = {
    "Jerusalem": "ירושלים",
    "Beer Sheva": "באר שבע",
    "Tel Aviv": "תל אביב",
    "Eilat": "אילת",
    "Haifa": "חיפה",
  };

  // Check exact match first
  if (cityMap[city]) {
    return cityMap[city];
  }

  // Check case-insensitive match
  const normalizedCity = city.trim();
  for (const [en, he] of Object.entries(cityMap)) {
    if (en.toLowerCase() === normalizedCity.toLowerCase()) {
      return he;
    }
  }

  // If already in Hebrew or unknown, return as is
  return city;
}

export function getReminderTypeNameHebrew(type: string): string {
  const types: Record<string, string> = {
    tefillin: "הנחת תפילין",
    candle_lighting: "הדלקת נרות",
    shema: "זמן קריאת שמע",
    sunset: "זמני שקיעה",
    prayer: "זמני תפילה",
  };
  return types[type] || type;
}
