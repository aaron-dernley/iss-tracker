/**
 * Tracks the International Space Station's current position (Open Notify's
 * `iss-now.json`, a free, unauthenticated, no-key API) and reports how far
 * it currently is from a configured ground location.
 *
 * `withinRange` is a great-circle-distance proxy for "roughly overhead,"
 * not a real visibility/pass prediction — true visibility depends on the
 * ISS's actual altitude, the observer's local horizon, and whether it's
 * currently in Earth's shadow (an object can be within range but not
 * visible if it's not sunlit while the ground is dark). This is
 * deliberately the honest scope: a fun proximity indicator, not a
 * pass-prediction tool. The default 2200km threshold approximates the
 * ISS's typical maximum ground-visibility radius from its ~400km orbital
 * altitude, but is a rule of thumb, not a computed line-of-sight radius.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Minimal logger shape methods depend on — matches `context.logger`. */
export interface MinimalLogger {
  info(msg: string, props?: Record<string, unknown>): void;
  warn(msg: string, props?: Record<string, unknown>): void;
}

export interface IssNowResponse {
  message: string;
  timestamp: number;
  iss_position: { latitude: string; longitude: string };
}

/**
 * Great-circle distance in km between two lat/lon points (haversine
 * formula, Earth radius 6371km). Pure math, independently verifiable
 * against any haversine reference.
 */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Parse Open Notify's `iss-now.json` response body. Throws on a
 * structurally unexpected response rather than silently returning zeros —
 * a malformed response should surface as a method failure, not a fake
 * "ISS is at 0,0" reading.
 */
export function parseIssNow(
  raw: string,
): { latitude: number; longitude: number; timestamp: number } {
  const parsed = JSON.parse(raw) as Partial<IssNowResponse>;
  if (
    !parsed.iss_position || typeof parsed.iss_position.latitude !== "string" ||
    typeof parsed.iss_position.longitude !== "string" ||
    typeof parsed.timestamp !== "number"
  ) {
    throw new Error(
      `Unexpected iss-now.json shape: ${raw.slice(0, 200)}`,
    );
  }
  const latitude = Number(parsed.iss_position.latitude);
  const longitude = Number(parsed.iss_position.longitude);
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    throw new Error(
      `iss-now.json reported non-numeric coordinates: ${raw.slice(0, 200)}`,
    );
  }
  return { latitude, longitude, timestamp: parsed.timestamp };
}

const GlobalArgsSchema = z.object({
  latitude: z.number().min(-90).max(90).describe(
    "Ground observer latitude in decimal degrees.",
  ),
  longitude: z.number().min(-180).max(180).describe(
    "Ground observer longitude in decimal degrees.",
  ),
  thresholdKm: z.number().positive().default(2200).describe(
    "Distance below which withinRange is true. 2200km is a rule-of-thumb " +
      "approximation of the ISS's typical ground-visibility radius from " +
      "its ~400km orbital altitude — not a computed line-of-sight radius, " +
      "and doesn't account for whether the ISS is currently sunlit.",
  ),
  apiUrl: z.string().default("http://api.open-notify.org/iss-now.json")
    .describe(
      "Override for testing or if Open Notify moves. Note: http, not https " +
        "— that's what this public API actually serves.",
    ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const PositionSchema = z.object({
  issLatitude: z.number().describe("ISS's current latitude, decimal degrees."),
  issLongitude: z.number().describe(
    "ISS's current longitude, decimal degrees.",
  ),
  issTimestamp: z.string().describe(
    "ISO-8601 timestamp Open Notify reported for this position fix (its own clock, not ours).",
  ),
  distanceKm: z.number().describe(
    "Great-circle distance from the configured observer location to the ISS's ground track, in km.",
  ),
  thresholdKm: z.number().describe(
    "The threshold this run was evaluated against.",
  ),
  withinRange: z.boolean().describe(
    "distanceKm < thresholdKm. A proximity proxy, not a real visibility/pass prediction — see module doc.",
  ),
  capturedAt: z.string().describe(
    "ISO-8601 timestamp when this snapshot was captured.",
  ),
});

interface MethodContext {
  globalArgs: GlobalArgs;
  logger: MinimalLogger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Model definition for `@aaronge/iss-tracker`. */
export const model = {
  type: "@aaronge/iss-tracker",
  version: "2026.08.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    position: {
      description:
        "ISS's current position and its distance from the configured observer location.",
      schema: PositionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
  },
  methods: {
    checkOverhead: {
      description:
        "Fetch the ISS's current position and compute distance from the configured location.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const { latitude, longitude, thresholdKm, apiUrl } = context.globalArgs;
        context.logger.info("Fetching ISS position from {apiUrl}", { apiUrl });

        const resp = await fetch(apiUrl);
        const raw = await resp.text();
        if (!resp.ok) {
          throw new Error(
            `ISS position fetch failed (${resp.status}): ${raw.slice(0, 200)}`,
          );
        }
        const { latitude: issLatitude, longitude: issLongitude, timestamp } =
          parseIssNow(raw);

        const distanceKm = haversineKm(
          latitude,
          longitude,
          issLatitude,
          issLongitude,
        );
        const withinRange = distanceKm < thresholdKm;

        context.logger.info(
          "ISS at {issLatitude},{issLongitude} — {distanceKm}km away, withinRange={withinRange}",
          {
            issLatitude,
            issLongitude,
            distanceKm: Math.round(distanceKm),
            withinRange,
          },
        );

        const handle = await context.writeResource("position", "position", {
          issLatitude,
          issLongitude,
          issTimestamp: new Date(timestamp * 1000).toISOString(),
          distanceKm,
          thresholdKm,
          withinRange,
          capturedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
