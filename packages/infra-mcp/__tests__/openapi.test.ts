import { describe, expect, it } from "vitest";
import { ROUTES, type Route } from "../src/routes";
import {
	RESOLUTION_TIERS,
	TRANSCRIPT_MAX_FILE_BYTES,
	TRANSCRIPT_STATUSES,
} from "../src/tools";
import { MAX_PARTS, MAX_VIDEO_BYTES, PART_URL_BATCH } from "../src/upload";

type Json = Record<string, unknown>;

type Spec = {
	paths: Record<string, Record<string, Json>>;
	components: { schemas: Record<string, Json> };
};

const source = new URL(
	"../../../apps/web/lib/developer-openapi.ts",
	import.meta.url,
).href;
const { developerOpenApiSpec } = (await import(source)) as {
	developerOpenApiSpec: (baseUrl: string) => Spec;
};
const spec = developerOpenApiSpec("https://cap.so");

const SECURITY = { secret: "secretKey", upload: "uploadToken" } as const;

const operationFor = (route: Route) =>
	spec.paths[route.path]?.[route.method.toLowerCase()];

const parameterNames = (operation: Json, place: string) =>
	((operation.parameters ?? []) as Json[])
		.filter((parameter) => parameter.in === place)
		.map((parameter) => parameter.name);

function bodyProperties(operation: Json) {
	const body = operation.requestBody as
		| { content: Record<string, { schema: { $ref: string } }> }
		| undefined;
	const reference = body?.content["application/json"]?.schema.$ref;
	if (!reference) return [];
	const schema = spec.components.schemas[reference.split("/").pop() ?? ""];
	return Object.keys((schema?.properties ?? {}) as Json);
}

describe("the documented API", () => {
	it.each(Object.entries(ROUTES))("documents %s", (_name, route: Route) => {
		const operation = operationFor(route);
		expect(
			operation,
			`${route.method} ${route.path} is not in the OpenAPI document`,
		).toBeDefined();
		if (!operation) return;

		expect(operation.security).toEqual([{ [SECURITY[route.auth]]: [] }]);
		expect(parameterNames(operation, "path")).toEqual(
			route.path.includes("{id}") ? ["id"] : [],
		);
		expect(parameterNames(operation, "query")).toEqual(
			expect.arrayContaining([...route.query]),
		);
		expect(parameterNames(operation, "header")).toEqual(
			expect.arrayContaining([...route.headers]),
		);
		expect(bodyProperties(operation)).toEqual(
			expect.arrayContaining([...route.body]),
		);
	});

	it("covers every route the server calls and nothing undocumented", () => {
		const documented = new Set(
			Object.entries(spec.paths).flatMap(([path, operations]) =>
				Object.keys(operations).map(
					(method) => `${method.toUpperCase()} ${path}`,
				),
			),
		);
		const called = Object.values(ROUTES).map(
			(route: Route) => `${route.method} ${route.path}`,
		);
		expect(new Set(called).size).toBe(called.length);
		for (const call of called) expect(documented.has(call)).toBe(true);
	});

	it("uses the documented upload limits", () => {
		const parts = spec.components.schemas.PresignPartRequest?.properties as
			| { partNumbers: { maxItems: number; items: { maximum: number } } }
			| undefined;
		expect(parts?.partNumbers.maxItems).toBe(PART_URL_BATCH);
		expect(parts?.partNumbers.items.maximum).toBe(MAX_PARTS);
		const create = spec.components.schemas.CreateUploadRequest?.properties as
			| {
					maxBytes: { maximum: number };
					maxResolutionTier: { enum: string[] };
			  }
			| undefined;
		expect(create?.maxBytes.maximum).toBe(MAX_VIDEO_BYTES);
		expect(create?.maxResolutionTier.enum).toEqual([...RESOLUTION_TIERS]);
		const file = spec.components.schemas.CreateTranscriptUploadRequest
			?.properties as { contentLength: { maximum: number } } | undefined;
		expect(file?.contentLength.maximum).toBe(TRANSCRIPT_MAX_FILE_BYTES);
	});

	it("filters transcripts by the documented statuses", () => {
		const parameters = (operationFor(ROUTES.listTranscripts)?.parameters ??
			[]) as { name: string; schema: { enum?: string[] } }[];
		expect(
			parameters.find((parameter) => parameter.name === "status")?.schema.enum,
		).toEqual([...TRANSCRIPT_STATUSES]);
	});
});
