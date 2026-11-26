import type { HttpApi } from "@effect/platform";
import type { Context, Layer as EffectLayer } from "effect";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { resetTorExitListCache } from "@/lib/tor-exit-gate";

const mocks = vi.hoisted(() => ({
	isRateLimited: vi.fn<(ruleId: string, opts?: unknown) => Promise<boolean>>(),
	sendEmail: vi.fn(async () => {}),
	databaseCalls: 0,
	dispose: async () => {},
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/rate-limit")>()),
	isRateLimited: mocks.isRateLimited,
}));
vi.mock("@cap/database/emails/config", () => ({
	sendEmail: mocks.sendEmail,
	getEmailDeliveryStatus: () => ({ configured: true }),
}));
vi.mock("@cap/env", async (importOriginal) => {
	const original = await importOriginal<typeof import("@cap/env")>();
	return {
		...original,
		serverEnv: () => ({
			...original.serverEnv(),
			CAP_TOR_EXIT_GATE: "deny",
		}),
	};
});
vi.mock("@cap/database/auth/disposable-signup", () => ({
	isDisposableEmailSignup: vi.fn(async () => false),
}));
vi.mock("@/lib/account-deletion-request", () => ({
	createAccountDeletionRequest: vi.fn(),
	createMobileContentReport: vi.fn(),
	hasPendingAccountDeletion: vi.fn(async () => false),
}));
vi.mock("@cap/database/auth/auth-options", () => ({
	authOptions: () => ({ adapter: {} }),
	getServerSession: async () => null,
}));

vi.mock("@/lib/server", async () => {
	const { Database, Videos } = await import("@cap/web-backend");
	const { HttpAuthMiddleware } = await import("@cap/web-domain");
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Effect, Layer } = await import("effect");

	const database = Layer.succeed(
		Database,
		Database.make({
			use: () => {
				mocks.databaseCalls += 1;
				return Effect.succeed([] as never);
			},
		}),
	);
	const videos = Layer.succeed(
		Videos,
		{} as unknown as Context.Tag.Service<typeof Videos>,
	);
	const auth = Layer.succeed(HttpAuthMiddleware, Effect.die("unused"));

	return {
		apiToHandler: (
			api: EffectLayer.Layer<
				HttpApi.Api,
				never,
				| Context.Tag.Identifier<typeof Database>
				| Context.Tag.Identifier<typeof Videos>
				| Context.Tag.Identifier<typeof HttpAuthMiddleware>
			>,
		) => {
			const handler = api.pipe(
				Layer.provideMerge(auth),
				Layer.provideMerge(database),
				Layer.provideMerge(videos),
				Layer.merge(HttpServer.layerContext),
				HttpApiBuilder.toWebHandler,
			);
			mocks.dispose = handler.dispose;
			return handler.handler;
		},
	};
});

const LISTED = "198.51.100.7";
const UNLISTED = "203.0.113.20";
const list = [
	...Array.from({ length: 60 }, (_, i) => `192.0.2.${i + 1}`),
	LISTED,
].join("\n");

describe("mobile sessions from a Tor exit in deny mode", () => {
	let GET: typeof import("@/app/api/mobile/[...route]/route").GET;
	let POST: typeof import("@/app/api/mobile/[...route]/route").POST;

	beforeAll(async () => {
		Object.assign(process.env, {
			NEXT_PUBLIC_WEB_URL: "http://localhost",
			WEB_URL: "http://localhost",
			DATABASE_URL: "mysql://unused:unused@127.0.0.1:3306/unused",
			NEXTAUTH_SECRET: "synthetic-test-secret-that-is-long-enough",
			NEXTAUTH_URL: "http://localhost",
			CAP_AWS_BUCKET: "synthetic",
			CAP_AWS_REGION: "us-east-1",
			CAP_AWS_ACCESS_KEY: "synthetic",
			CAP_AWS_SECRET_KEY: "synthetic",
			RESEND_API_KEY: "synthetic",
			NODE_ENV: "test",
		});
		({ GET, POST } = await import("@/app/api/mobile/[...route]/route"));
	});

	beforeEach(() => {
		resetTorExitListCache();
		mocks.isRateLimited.mockReset().mockResolvedValue(true);
		mocks.sendEmail.mockClear();
		mocks.databaseCalls = 0;
		vi.stubEnv("VERCEL", "1");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(list)),
		);
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	afterAll(() => mocks.dispose());

	const post = (path: string, address: string, body: unknown) =>
		POST(
			new Request(`http://localhost/api/mobile/session/email/${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-real-ip": address },
				body: JSON.stringify(body),
			}),
		);

	const requestSession = (address: string) =>
		GET(
			new Request(
				"http://localhost/api/mobile/session/request?provider=google",
				{ headers: { "x-real-ip": address } },
			),
		);

	it("refuses an email code request before rate limits or email", async () => {
		const response = await post("request", LISTED, {
			email: "person@example.com",
		});

		expect(response.status).toBe(403);
		expect(mocks.isRateLimited).not.toHaveBeenCalled();
		expect(mocks.sendEmail).not.toHaveBeenCalled();
	});

	it("refuses an email code verification before any lookup", async () => {
		const response = await post("verify", LISTED, {
			email: "person@example.com",
			code: "123456",
		});

		expect(response.status).toBe(403);
		expect(mocks.isRateLimited).not.toHaveBeenCalled();
		expect(mocks.databaseCalls).toBe(0);
	});

	it("passes other addresses on to the next check", async () => {
		const request = await post("request", UNLISTED, {
			email: "person@example.com",
		});
		const verify = await post("verify", UNLISTED, {
			email: "person@example.com",
			code: "123456",
		});

		expect(request.status).toBe(429);
		expect(verify.status).toBe(429);
		expect(mocks.isRateLimited).toHaveBeenCalledTimes(2);
	});

	it("redirects a session request to the blocked notice", async () => {
		const response = await requestSession(LISTED);

		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("location") ?? "");
		expect(location.pathname).toBe("/login");
		expect(location.searchParams.get("error")).toBe("SignupBlocked");
	});

	it("sends other addresses to the normal sign-in page", async () => {
		const response = await requestSession(UNLISTED);

		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("location") ?? "");
		expect(location.pathname).toBe("/login");
		expect(location.searchParams.get("error")).toBeNull();
	});
});
