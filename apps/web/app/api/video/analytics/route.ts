import { VideosAnalytics } from "@cap/web-backend";
import { VideoAnalytics } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { geolocation } from "@vercel/functions";
import { Effect, Layer } from "effect";
import { apiToHandler } from "@/lib/server";

const normalizeHeaderValue = (value?: string | null) => {
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

const LOCALHOST_GEO_DATA = {
	city: normalizeHeaderValue(process.env.LOCAL_GEO_CITY) ?? "San Francisco",
	country: normalizeHeaderValue(process.env.LOCAL_GEO_COUNTRY) ?? "US",
} as const;

const isRunningOnVercel = process.env.VERCEL === "1";

class Api extends HttpApi.make("VideoAnalyticsCaptureApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("captureAnalytics")`/api/video/analytics`
			.setPayload(VideoAnalytics.VideoCaptureEvent)
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.InternalServerError),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			Effect.gen(function* () {
				const videosAnalytics = yield* VideosAnalytics;

				return handlers.handle("captureAnalytics", ({ payload }) =>
					videosAnalytics.captureEvent(payload).pipe(
						Effect.catchTags({
							HttpBodyError: () => new HttpApiError.BadRequest(),
							RequestError: () => new HttpApiError.InternalServerError(),
							ResponseError: () => new HttpApiError.InternalServerError(),
						}),
					),
				);
			}),
		),
	),
);

const handler = apiToHandler(ApiLive);

const CITY_HEADER_KEYS = [
	"x-vercel-ip-city",
	"cf-ipcity",
	"x-nf-geo-city",
	"x-geo-city",
	"x-appengine-city",
] as const;

const COUNTRY_HEADER_KEYS = [
	"x-vercel-ip-country",
	"cf-ipcountry",
	"x-nf-geo-country",
	"x-geo-country",
	"x-appengine-country",
	"x-country-code",
] as const;

const pickHeaderValue = (request: Request, keys: readonly string[]) => {
	for (const key of keys) {
		const value = normalizeHeaderValue(request.headers.get(key));
		if (value) return value;
	}

	return undefined;
};

const getGeoFromRequest = (request: Request) => {
	if (!isRunningOnVercel) return { city: undefined, country: undefined };

	try {
		const details = geolocation(request);
		return {
			city: normalizeHeaderValue(details.city),
			country: normalizeHeaderValue(details.country),
		};
	} catch {
		return { city: undefined, country: undefined };
	}
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const POST = async (request: Request) => {
	const { city: geoCity, country: geoCountry } = getGeoFromRequest(request);
	const headerCity = pickHeaderValue(request, CITY_HEADER_KEYS);
	const headerCountry = pickHeaderValue(request, COUNTRY_HEADER_KEYS);

	const fallbackCity = !isRunningOnVercel ? LOCALHOST_GEO_DATA.city : undefined;
	const fallbackCountry = !isRunningOnVercel ? LOCALHOST_GEO_DATA.country : undefined;

	const derivedCity = geoCity ?? headerCity ?? fallbackCity;
	const derivedCountry = geoCountry ?? headerCountry ?? fallbackCountry;

	if (!derivedCity && !derivedCountry) return handler(request);

	let parsedBody: unknown;
	try {
		parsedBody = await request.clone().json();
	} catch {
		return handler(request);
	}

	if (!isRecord(parsedBody)) return handler(request);

	const existingCity = normalizeHeaderValue(
		typeof parsedBody.city === "string" ? parsedBody.city : undefined,
	);
	const existingCountry = normalizeHeaderValue(
		typeof parsedBody.country === "string" ? parsedBody.country : undefined,
	);

	const cityToApply = !existingCity ? derivedCity : undefined;
	const countryToApply = !existingCountry ? derivedCountry : undefined;

	if (!cityToApply && !countryToApply) return handler(request);

	const enhancedPayload = {
		...parsedBody,
		...(cityToApply ? { city: cityToApply } : {}),
		...(countryToApply ? { country: countryToApply } : {}),
	};

	const headers = new Headers(request.headers);
	headers.delete("content-length");

	const enhancedRequest = new Request(request, {
		headers,
		body: JSON.stringify(enhancedPayload),
	});

	return handler(enhancedRequest);
};
