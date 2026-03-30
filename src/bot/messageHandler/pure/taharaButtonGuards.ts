/** True when in tahara flow and button is one of: 8:00, morning, 30, 60, one_hour (and variants). */
export function isTaharaTimePickerButton(
  normalizedButton: string,
  cleanButton: string,
  buttonIdentifier: string
): boolean {
  return (
    isTaharaMorningOption(normalizedButton, cleanButton, buttonIdentifier) ||
    isTahara30MinOption(normalizedButton, cleanButton, buttonIdentifier) ||
    isTahara60MinOption(normalizedButton, cleanButton, buttonIdentifier)
  );
}

export function isTaharaMorningOption(
  normalizedButton: string,
  cleanButton: string,
  buttonIdentifier: string
): boolean {
  const id = buttonIdentifier.trim().toLowerCase();
  return (
    normalizedButton === "morning" ||
    normalizedButton === "8:00" ||
    normalizedButton === "08:00" ||
    cleanButton === "8:00" ||
    cleanButton === "08:00" ||
    id === "8:00" ||
    id === "08:00" ||
    id === "morning"
  );
}

export function isTahara30MinOption(
  normalizedButton: string,
  cleanButton: string,
  buttonIdentifier: string
): boolean {
  const id = buttonIdentifier.trim().toLowerCase();
  return (
    normalizedButton === "30" ||
    cleanButton === "30" ||
    id === "30" ||
    id === "30_dakot" ||
    normalizedButton === "30_dakot" ||
    /30\s*דקות/.test(buttonIdentifier) ||
    /\b30\b/.test(id)
  );
}

export function isTahara60MinOption(
  normalizedButton: string,
  cleanButton: string,
  buttonIdentifier: string
): boolean {
  const id = buttonIdentifier.trim().toLowerCase();
  return (
    normalizedButton === "60" ||
    normalizedButton === "one_hour" ||
    cleanButton === "60" ||
    cleanButton === "one_hour" ||
    id === "60" ||
    id === "one_hour" ||
    id === "1_hour" ||
    /1\s*שעה|שעה\s*לפני/.test(buttonIdentifier) ||
    /\b60\b/.test(id)
  );
}
