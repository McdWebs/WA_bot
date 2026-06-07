import winston from "winston";
import { config } from "../config";

/** Last 4 digits — readable without logging full numbers */
export function shortPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length > 4 ? `…${digits.slice(-4)}` : phone;
}

const compactConsole = winston.format.printf(
  ({ level, message, timestamp, stack, ...rest }) => {
    const skip = new Set([
      "service",
      "level",
      "timestamp",
      "splat",
      "Symbol(level)",
      "Symbol(message)",
      "Symbol(splat)",
      "Symbol(timestamp)",
    ]);
    const meta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (!skip.has(k) && v !== undefined) meta[k] = v;
    }
    const metaStr =
      Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
    const ts =
      typeof timestamp === "string" && timestamp.length >= 19
        ? timestamp.slice(11, 19)
        : "";
    const prefix = ts ? `${ts} ` : "";
    const stackStr = stack ? `\n${stack}` : "";
    return `${prefix}${level}: ${message}${metaStr}${stackStr}`;
  }
);

const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat()
  ),
  defaultMeta: { service: "wa-bot" },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), compactConsole),
    }),
  ],
});

export default logger;
