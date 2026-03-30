import logger from "../../../utils/logger";

/**
 * Infers location from phone number country code
 */
export function inferLocationFromPhoneNumber(phoneNumber: string): string {
  // Remove any non-digit characters except +
  const cleaned = phoneNumber.replace(/[^\d+]/g, "");

  // Country code to location mapping (for Hebrew calendar, prioritize Israel)
  const countryCodeMap: Record<string, string> = {
    "972": "Jerusalem", // Israel
    "1": "New York", // USA/Canada
    "44": "London", // UK
    "33": "Paris", // France
    "49": "Berlin", // Germany
    "7": "Moscow", // Russia
    "61": "Sydney", // Australia
    "81": "Tokyo", // Japan
  };

  // Extract country code (first 1-3 digits after +)
  for (const [code, city] of Object.entries(countryCodeMap)) {
    if (cleaned.startsWith(`+${code}`) || cleaned.startsWith(code)) {
      logger.info(
        `Inferred location "${city}" from phone number country code: ${code}`
      );
      return city;
    }
  }

  // Default to Jerusalem for Hebrew calendar
  logger.info(
    `Using default location "Jerusalem" for phone number: ${phoneNumber}`
  );
  return "Jerusalem";
}
