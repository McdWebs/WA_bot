/**
 * WhatsApp list-picker row should use a stable payload such as `custom_location`
 * so this matches; Hebrew titles are supported heuristically.
 */
export function isCustomLocationButton(
  normalizedButton: string,
  cleanButton: string,
  buttonIdentifier: string
): boolean {
  const id = normalizedButton;
  const collapsedClean = cleanButton.replace(/[\s_]+/g, "").toLowerCase();
  const collapsedId = id.replace(/[\s_]+/g, "").toLowerCase();
  const exact = new Set([
    "custom_location",
    "custom_city",
    "custom",
    "other",
    "enter_city",
    "type_city",
    "my_city",
    "free_text_city",
    "אחר",
    "עיר_אחרת",
    "מיקום_אחר",
  ]);
  if (
    exact.has(id) ||
    exact.has(cleanButton) ||
    exact.has(collapsedClean) ||
    exact.has(collapsedId)
  ) {
    return true;
  }
  if (id.includes("custom_location") || id.includes("custom city")) {
    return true;
  }
  const raw = buttonIdentifier.trim().toLowerCase();
  if (raw.includes("אחר") && (raw.includes("עיר") || raw.includes("מיקום"))) {
    return true;
  }
  if (raw.includes("custom") && raw.includes("city")) {
    return true;
  }
  return false;
}
