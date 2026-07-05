import mongoService from "./mongo";
import logger from "../utils/logger";
import type { TefillinStation } from "../types";

/** Stations farther than this from the user are not considered "nearby". */
export const MAX_RADIUS_KM = 50;

export type NearbyStation = TefillinStation & { distance_km: number };

/**
 * Returns up to `limit` tefillin stations nearest to the given coordinates,
 * filtered to those within MAX_RADIUS_KM, sorted by distance ascending.
 */
export async function findNearestStations(
  latitude: number,
  longitude: number,
  limit = 8
): Promise<NearbyStation[]> {
  const stations = await mongoService.findNearestTefillinStations(
    latitude,
    longitude,
    limit
  );
  const nearby = stations.filter((s) => s.distance_km <= MAX_RADIUS_KM);
  logger.debug(
    `Tefillin stations near ${latitude},${longitude}: ${nearby.length}/${stations.length} within ${MAX_RADIUS_KM}km`
  );
  return nearby;
}

/**
 * Hebrew, WhatsApp-friendly list of nearby stations (name, address, km).
 */
export function formatStationsMessage(stations: NearbyStation[]): string {
  if (stations.length === 0) {
    return `לא נמצאו עמדות תפילין קרובות אליך (עד ${MAX_RADIUS_KM} ק"מ). 🙏`;
  }

  const lines: string[] = ["📍 עמדות תפילין קרובות אליך:", ""];
  stations.forEach((s, index) => {
    lines.push(`${index + 1}. ${s.name}`);
    lines.push(`   📫 ${s.address}`);
    lines.push(`   🚶 ${s.distance_km.toFixed(1)} ק"מ`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}
