import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@0.20260824.32";
import { haversineKm, model, parseIssNow } from "./iss_tracker.ts";

function asContext<T>(context: unknown): T {
  return context as T;
}

const DEFAULT_GLOBAL_ARGS = {
  latitude: 51.5074,
  longitude: -0.1278,
  thresholdKm: 2200,
  apiUrl: "http://api.open-notify.org/iss-now.json",
};

// --- haversineKm -----------------------------------------------------------

Deno.test("haversineKm returns 0 for identical points", () => {
  assertEquals(haversineKm(51.5, -0.1, 51.5, -0.1), 0);
});

Deno.test("haversineKm: London to Paris is approximately 344km", () => {
  const km = haversineKm(51.5074, -0.1278, 48.8566, 2.3522);
  assert(km > 330 && km < 360, `expected ~344km, got ${km}`);
});

Deno.test("haversineKm: antipodal points are approximately half Earth's circumference", () => {
  const km = haversineKm(0, 0, 0, 180);
  assert(km > 20000 && km < 20040, `expected ~20015km, got ${km}`);
});

// --- parseIssNow -------------------------------------------------------------

// Captured live from api.open-notify.org on 2026-08-28.
const REAL_ISS_NOW_RESPONSE =
  '{"message": "success", "timestamp": 1787875201, "iss_position": {"latitude": "-10.4977", "longitude": "-40.8186"}}';

Deno.test("parseIssNow parses a real captured response", () => {
  const result = parseIssNow(REAL_ISS_NOW_RESPONSE);
  assertEquals(result.latitude, -10.4977);
  assertEquals(result.longitude, -40.8186);
  assertEquals(result.timestamp, 1787875201);
});

Deno.test("parseIssNow throws on missing iss_position", () => {
  let threw = false;
  try {
    parseIssNow('{"message": "success", "timestamp": 123}');
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("parseIssNow throws on non-numeric coordinates", () => {
  let threw = false;
  try {
    parseIssNow(
      '{"message": "success", "timestamp": 123, "iss_position": {"latitude": "n/a", "longitude": "n/a"}}',
    );
  } catch {
    threw = true;
  }
  assert(threw);
});

// --- checkOverhead -----------------------------------------------------------

Deno.test("checkOverhead computes distance and withinRange from a mocked fetch", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "checkOverhead",
  });

  await withMockedFetch(
    () => new Response(REAL_ISS_NOW_RESPONSE, { status: 200 }),
    () => model.methods.checkOverhead.execute({}, asContext(context)),
  );

  const data = getWrittenResources()[0].data as {
    issLatitude: number;
    distanceKm: number;
    withinRange: boolean;
    thresholdKm: number;
  };
  assertEquals(data.issLatitude, -10.4977);
  assertEquals(data.thresholdKm, 2200);
  assert(
    data.distanceKm > 7000,
    "London to that position should be far, not withinRange",
  );
  assertEquals(data.withinRange, false);
});

Deno.test("checkOverhead reports withinRange=true when the ISS is close to the configured location", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { ...DEFAULT_GLOBAL_ARGS, latitude: -10.5, longitude: -40.8 },
    methodName: "checkOverhead",
  });

  await withMockedFetch(
    () => new Response(REAL_ISS_NOW_RESPONSE, { status: 200 }),
    () => model.methods.checkOverhead.execute({}, asContext(context)),
  );

  const data = getWrittenResources()[0].data as {
    distanceKm: number;
    withinRange: boolean;
  };
  assert(data.distanceKm < 100);
  assertEquals(data.withinRange, true);
});

Deno.test("checkOverhead throws on a non-200 response, writing nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "checkOverhead",
  });

  await assertRejects(
    () =>
      withMockedFetch(
        () => new Response("Service Unavailable", { status: 503 }),
        () => model.methods.checkOverhead.execute({}, asContext(context)),
      ).then((r) => r.result),
    Error,
    "503",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("checkOverhead throws on a malformed response body, writing nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: DEFAULT_GLOBAL_ARGS,
    methodName: "checkOverhead",
  });

  await assertRejects(
    () =>
      withMockedFetch(
        () => new Response("not json", { status: 200 }),
        () => model.methods.checkOverhead.execute({}, asContext(context)),
      ).then((r) => r.result),
  );
  assertEquals(getWrittenResources().length, 0);
});
