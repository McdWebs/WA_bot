/**
 * Checks if a message body represents a button click from an interactive template
 */
export function isButtonClick(messageBody: string): boolean {
  if (!messageBody) return false;

  const normalized = messageBody.trim();

  // Check if it's a single digit (1-9) which is common for menu buttons
  // Also check for "1." or "1:" patterns that might come from templates
  if (/^[1-9][\.:]?$/.test(normalized) || /^[1-9]\s*[\.:]/.test(normalized)) {
    return true;
  }

  // Check for common button patterns
  const buttonPatterns = [
    /^sunset/i,
    /^candle/i,
    /^prayer/i,
    /^menu_/i,
    /^option\s*[1-9]/i,
  ];

  return buttonPatterns.some((pattern) => pattern.test(normalized));
}
