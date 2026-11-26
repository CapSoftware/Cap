import type { HttpApi } from "@effect/platform";
import type { Context, Layer as EffectLayer } from "effect";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { consoleErrorBody } from "@/lib/infra-console-errors";

const mocks = vi.hoisted(() => ({
	owns: true,
	create: null as null | (() => Promise<unknown>),
	dispose: async () => {},
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/infra-video-upload", () => ({
	MAX_PRESIGN_BATCH: 50,
	ownsInfraApp: async () => mocks.owns,
	createInfraVideo: () => mocks.create?.(),
	initiateInfraUpload: async () => ({ status: 200, body: { uploadId: "u" } }),
	presignInfraUploadParts: async () => ({ status: 200, body: { parts: [] } }),
	completeInfraUpload: async () => ({ status: 200, body: { success: true } }),
	abortInfraUpload: async () => ({ status: 200, body: { success: true } }),
}));

vi.mock("@/lib/server", async () => {
	const { HttpAuthMiddleware, Organisation, User } = await import(
		"@cap/web-domain"
	);
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Effect, Layer, Option } = await import("effect");
	const auth = Layer.succeed(
		HttpAuthMiddleware,
		Effect.succeed({
			id: User.UserId.make("user"),
			email: "user@example.com",
			activeOrganizationId: Organisation.OrganisationId.make("org"),
			iconUrlOrKey: Option.none(),
		}),
	);
	return {
		apiToHandler: (
			api: EffectLayer.Layer<
				HttpApi.Api,
				never,
				Context.Tag.Identifier<typeof HttpAuthMiddleware>
			>,
		) => {
			const handler = api.pipe(
				Layer.provideMerge(auth),
				Layer.merge(HttpServer.layerContext),
				HttpApiBuilder.toWebHandler,
			);
			mocks.dispose = handler.dispose;
			return handler.handler;
		},
	};
});

const SHAPE = ["code", "docs", "error", "hint", "message"];
const REFUSAL_MESSAGE =
	"Not enough credit to upload. Add credits to start uploading.";

describe("console upload errors", () => {
	let route: typeof import("@/app/api/developer/console/upload/[...route]/route");

	beforeAll(async () => {
		route = await import("@/app/api/developer/console/upload/[...route]/route");
	});

	beforeEach(() => {
		mocks.owns = true;
		mocks.create = null;
	});

	afterAll(() => mocks.dispose());

	const post = (path: string, body: unknown) =>
		route.POST(
			new Request(`http://localhost/api/developer/console/upload/${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);

	const read = async (response: Response) => {
		const text = await response.text();
		expect(text).not.toContain("_tag");
		const body = JSON.parse(text) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(SHAPE);
		return body;
	};

	it("answers a credit refusal with its plain message and the app's Billing link", async () => {
		mocks.create = async () => ({
			status: 402,
			body: {
				error: "Insufficient credits",
				code: "insufficient_credits",
				message: REFUSAL_MESSAGE,
				hint: "Add credits to this app at https://cap.so/dashboard/infra/app-1/billing, then retry.",
				docs: "https://cap.so/docs/api/rest-api",
				standing: "active",
				pausesAt: null,
				balanceMicroCredits: 0,
				requiredMicroCredits: 1,
				shortfallMicroCredits: 1,
			},
		});

		const response = await post("create", { appId: "app-1" });

		expect(response.status).toBe(402);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(await read(response)).toEqual({
			error: REFUSAL_MESSAGE,
			code: "insufficient_credits",
			message: REFUSAL_MESSAGE,
			hint: "Add credits to this app at https://cap.so/dashboard/infra/app-1/billing, then retry.",
			docs: "https://cap.so/docs/api/rest-api",
		});
	});

	it("words a request the schema rejects plainly, without the decoder's detail", async () => {
		const response = await post("presign", {
			appId: "app-1",
			videoId: "v",
			uploadId: "u",
			partNumbers: [0],
		});

		expect(response.status).toBe(400);
		expect(await read(response)).toMatchObject({
			code: "invalid_request",
			message: "The upload request was not valid",
		});
	});

	it("says App not found for an app the user does not own", async () => {
		mocks.owns = false;
		const response = await post("create", { appId: "someone-else" });

		expect(response.status).toBe(404);
		expect(await read(response)).toMatchObject({
			code: "not_found",
			message: "App not found",
		});
	});

	it("hides what went wrong inside when the upload throws", async () => {
		mocks.create = async () => {
			throw new Error("connect ECONNREFUSED 10.0.0.1:3306");
		};
		const response = await post("create", { appId: "app-1" });

		expect(response.status).toBe(500);
		const body = await read(response);
		expect(body).toMatchObject({
			code: "upload_failed",
			message: "Upload failed",
		});
		expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
	});

	it("passes a success through untouched", async () => {
		mocks.create = async () => ({ status: 200, body: { videoId: "v_1" } });
		const response = await post("create", { appId: "app-1" });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ videoId: "v_1" });
	});
});

describe("consoleErrorBody", () => {
	it.each([
		[400, { _tag: "HttpApiDecodeError", message: "Expected string" }],
		[401, { _tag: "Unauthorized" }],
		[402, { _tag: "SomethingElse", message: "internal" }],
		[429, null],
		[500, "not json"],
		[503, { _tag: "UploadFailed" }],
	])("keeps a %i in the five-field shape with no internals", (status, raw) => {
		const body = consoleErrorBody(status, raw);

		expect(Object.keys(body).sort()).toEqual(SHAPE);
		expect(JSON.stringify(body)).not.toContain("_tag");
		expect(body.message).not.toBe("internal");
		expect(body.message).not.toBe("Expected string");
		expect(body.error).toBe(body.message);
	});
});
