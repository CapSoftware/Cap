import { createEnv } from "@t3-oss/env-nextjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const createReference = () =>
	createEnv({
		client: {
			NEXT_PUBLIC_IS_CAP: z.string().optional(),
			NEXT_PUBLIC_OPENPANEL_CLIENT_ID: z.string().optional(),
			NEXT_PUBLIC_OPENPANEL_API_URL: z.string().optional(),
			NEXT_PUBLIC_WEB_URL: z.string(),
			NEXT_PUBLIC_DOCKER_BUILD: z.string().optional(),
		},
		runtimeEnv: {
			NEXT_PUBLIC_IS_CAP: process.env.NEXT_PUBLIC_IS_CAP,
			NEXT_PUBLIC_OPENPANEL_CLIENT_ID:
				process.env.NEXT_PUBLIC_OPENPANEL_CLIENT_ID,
			NEXT_PUBLIC_OPENPANEL_API_URL: process.env.NEXT_PUBLIC_OPENPANEL_API_URL,
			NEXT_PUBLIC_WEB_URL:
				process.env.WEB_URL ?? process.env.NEXT_PUBLIC_WEB_URL,
			NEXT_PUBLIC_DOCKER_BUILD: process.env.NEXT_PUBLIC_DOCKER_BUILD,
		},
	});

const loadEnvModule = async () => {
	vi.resetModules();
	return await import("@cap/env");
};

const ENV_KEYS = [
	"WEB_URL",
	"NEXT_PUBLIC_WEB_URL",
	"NEXT_PUBLIC_IS_CAP",
	"NEXT_PUBLIC_OPENPANEL_CLIENT_ID",
	"NEXT_PUBLIC_OPENPANEL_API_URL",
	"NEXT_PUBLIC_DOCKER_BUILD",
] as const;

type Scenario = Partial<Record<(typeof ENV_KEYS)[number], string>>;

const VALID_SCENARIOS: Array<[string, Scenario]> = [
	[
		"every variable set",
		{
			WEB_URL: "https://server.example",
			NEXT_PUBLIC_WEB_URL: "https://public.example",
			NEXT_PUBLIC_IS_CAP: "true",
			NEXT_PUBLIC_OPENPANEL_CLIENT_ID: "client-id",
			NEXT_PUBLIC_OPENPANEL_API_URL: "https://op.example",
			NEXT_PUBLIC_DOCKER_BUILD: "true",
		},
	],
	["only WEB_URL", { WEB_URL: "https://server.example" }],
	["only NEXT_PUBLIC_WEB_URL", { NEXT_PUBLIC_WEB_URL: "https://pub.example" }],
	["an empty WEB_URL", { WEB_URL: "", NEXT_PUBLIC_WEB_URL: "https://p.test" }],
	["an empty NEXT_PUBLIC_WEB_URL", { NEXT_PUBLIC_WEB_URL: "" }],
	[
		"empty optional variables",
		{
			NEXT_PUBLIC_WEB_URL: "https://pub.example",
			NEXT_PUBLIC_IS_CAP: "",
			NEXT_PUBLIC_DOCKER_BUILD: "",
		},
	],
];

const INVALID_SCENARIOS: Array<[string, Scenario]> = [
	["no web URL", {}],
	[
		"no web URL but every optional variable",
		{
			NEXT_PUBLIC_IS_CAP: "true",
			NEXT_PUBLIC_OPENPANEL_CLIENT_ID: "client-id",
			NEXT_PUBLIC_OPENPANEL_API_URL: "https://op.example",
			NEXT_PUBLIC_DOCKER_BUILD: "true",
		},
	],
];

const PROPERTIES: Array<string | symbol> = [
	"NEXT_PUBLIC_IS_CAP",
	"NEXT_PUBLIC_OPENPANEL_CLIENT_ID",
	"NEXT_PUBLIC_OPENPANEL_API_URL",
	"NEXT_PUBLIC_WEB_URL",
	"NEXT_PUBLIC_DOCKER_BUILD",
	"NEXT_PUBLIC_UNKNOWN",
	"WEB_URL",
	"DATABASE_URL",
	"toJSON",
	"toString",
	"valueOf",
	"constructor",
	"hasOwnProperty",
	"__proto__",
	"then",
	"__esModule",
	"$$typeof",
	Symbol.toPrimitive,
	Symbol.iterator,
];

const RUNTIMES = ["server", "client"] as const;

const applyScenario = (
	scenario: Scenario,
	runtime: (typeof RUNTIMES)[number],
) => {
	for (const key of ENV_KEYS) vi.stubEnv(key, scenario[key]);
	if (runtime === "client") vi.stubGlobal("window", {});
};

const capture = (run: () => unknown) => {
	try {
		return { value: run() };
	} catch (error) {
		return { error: (error as Error).message };
	}
};

const read = (env: object, property: string | symbol) =>
	capture(() => Reflect.get(env, property));

describe("buildEnv", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	describe.each(RUNTIMES)("on the %s", (runtime) => {
		it.each(VALID_SCENARIOS)(
			"matches createEnv with %s",
			async (_, scenario) => {
				applyScenario(scenario, runtime);
				const reference = createReference();
				const { buildEnv } = await loadEnvModule();

				for (const property of PROPERTIES) {
					expect(read(buildEnv, property), String(property)).toEqual(
						read(reference, property),
					);
				}
			},
		);

		it.each(INVALID_SCENARIOS)(
			"fails like createEnv with %s",
			async (_, scenario) => {
				applyScenario(scenario, runtime);
				const consoleError = vi
					.spyOn(console, "error")
					.mockImplementation(() => {});

				const reference = capture(createReference);
				expect(reference).toEqual({ error: "Invalid environment variables" });
				const referenceLog = consoleError.mock.calls;
				expect(referenceLog).toHaveLength(1);

				const { buildEnv } = await loadEnvModule();

				for (const property of PROPERTIES) {
					consoleError.mockClear();
					if (typeof property !== "string") {
						expect(read(buildEnv, property)).toEqual({ value: undefined });
						expect(consoleError).not.toHaveBeenCalled();
						continue;
					}
					expect(read(buildEnv, property), property).toEqual(reference);
					expect(consoleError.mock.calls, property).toEqual(referenceLog);
				}
			},
		);
	});

	it("rejects server variables only in the browser", async () => {
		applyScenario({ NEXT_PUBLIC_WEB_URL: "https://pub.example" }, "client");
		const { buildEnv: inBrowser } = await loadEnvModule();
		expect(read(inBrowser, "DATABASE_URL")).toEqual({
			error:
				"❌ Attempted to access a server-side environment variable on the client",
		});

		vi.unstubAllGlobals();
		const { buildEnv: onServer } = await loadEnvModule();
		expect(read(onServer, "DATABASE_URL")).toEqual({ value: undefined });
	});

	it("prefers WEB_URL over NEXT_PUBLIC_WEB_URL", async () => {
		applyScenario(
			{
				WEB_URL: "https://server.example",
				NEXT_PUBLIC_WEB_URL: "https://public.example",
			},
			"server",
		);

		expect((await loadEnvModule()).buildEnv.NEXT_PUBLIC_WEB_URL).toBe(
			"https://server.example",
		);
	});
});
