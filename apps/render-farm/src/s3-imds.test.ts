import {
	afterEach,
	describe,
	expect,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import { S3, type S3Config } from "./s3";

const now = new Date("2026-10-26T09:00:00.000Z");
const validCredentials = {
	Code: "Success",
	AccessKeyId: "example-access-key",
	SecretAccessKey: "example-secret-key",
	Token: "example-session-token",
	Expiration: "2026-10-26T15:00:00.000Z",
};
const config = (): S3Config => ({
	endpoint: "https://s3.us-east-1.amazonaws.com",
	region: "us-east-1",
	bucket: "media",
	accessKeyId: "old-access-key",
	secretAccessKey: "old-secret-key",
	sessionToken: "old-token",
	virtualHost: true,
	imds: true,
});

const mockMetadata = (responses: Array<() => Response>) => {
	const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("Unexpected metadata request"),
	);
	for (const response of responses) fetchMock.mockResolvedValueOnce(response());
	return fetchMock;
};

const token = () => new Response("imds-token");
const role = () => new Response("render-role\n");
const credentials = () => Response.json(validCredentials);

describe("S3 instance-role credentials", () => {
	afterEach(() => setSystemTime());

	test.each([401, 403, 500])(
		"rejects failed token requests (%i) before sending credentials requests",
		async (status) => {
			setSystemTime(now);
			const fetchMock = mockMetadata([
				() => new Response("metadata rejected", { status }),
				role,
				credentials,
			]);
			const s3 = new S3(config());
			try {
				await expect(s3.ready()).rejects.toThrow(String(status));
				expect(fetchMock).toHaveBeenCalledTimes(1);
				expect(s3.config.accessKeyId).toBe("old-access-key");
			} finally {
				fetchMock.mockRestore();
			}
		},
	);

	test.each([
		["role", 401],
		["role", 403],
		["role", 500],
		["credentials", 401],
		["credentials", 403],
		["credentials", 500],
	] as const)(
		"rejects an HTTP error at the %s stage (%i)",
		async (stage, status) => {
			setSystemTime(now);
			const fetchMock = mockMetadata([
				token,
				stage === "role" ? () => new Response("render-role", { status }) : role,
				() => Response.json(validCredentials, { status }),
			]);
			const s3 = new S3(config());
			try {
				await expect(s3.ready()).rejects.toThrow(String(status));
				expect(fetchMock).toHaveBeenCalledTimes(stage === "role" ? 2 : 3);
				expect(s3.config).toEqual(config());
			} finally {
				fetchMock.mockRestore();
			}
		},
	);

	test.each(["token", "role"])(
		"rejects an empty %s before fetching credentials",
		async (empty) => {
			setSystemTime(now);
			const fetchMock = mockMetadata([
				empty === "token" ? () => new Response(" ") : token,
				empty === "role" ? () => new Response("\n") : role,
				credentials,
			]);
			try {
				await expect(new S3(config()).ready()).rejects.toThrow();
				expect(fetchMock).toHaveBeenCalledTimes(empty === "token" ? 1 : 2);
			} finally {
				fetchMock.mockRestore();
			}
		},
	);

	test.each([
		{ ...validCredentials, Code: "AssumeRoleUnauthorizedAccess" },
		{ ...validCredentials, AccessKeyId: "" },
		{ ...validCredentials, SecretAccessKey: null },
		{ ...validCredentials, Token: "" },
		{ ...validCredentials, Expiration: "invalid-date" },
		{ ...validCredentials, Expiration: "2026-10-26T08:59:59.000Z" },
		{ ...validCredentials, Expiration: now.toISOString() },
		null,
	])(
		"keeps the previous credentials after an invalid response %#",
		async (invalid) => {
			setSystemTime(now);
			const initial = config();
			const fetchMock = mockMetadata([
				token,
				role,
				() => Response.json(invalid),
				token,
				role,
				credentials,
			]);
			const s3 = new S3(initial);
			try {
				await expect(s3.ready()).rejects.toThrow();
				expect(s3.config).toEqual(config());
				await s3.ready();
				expect(s3.config.accessKeyId).toBe(validCredentials.AccessKeyId);
				expect(fetchMock).toHaveBeenCalledTimes(6);
			} finally {
				fetchMock.mockRestore();
			}
		},
	);

	test("shares a bounded refresh, then reuses valid credentials", async () => {
		setSystemTime(now);
		const fetchMock = mockMetadata([token, role, credentials]);
		try {
			const s3 = new S3(config());
			await Promise.all([s3.ready(), s3.ready(), s3.ready()]);
			expect(fetchMock).toHaveBeenCalledTimes(3);
			const signals = fetchMock.mock.calls.map(([, init]) => init?.signal);
			expect(signals[0]).toBeInstanceOf(AbortSignal);
			expect(signals.every((signal) => signal === signals[0])).toBe(true);
			expect(s3.config.sessionToken).toBe(validCredentials.Token);
			await s3.ready();
			expect(fetchMock).toHaveBeenCalledTimes(3);
		} finally {
			fetchMock.mockRestore();
		}
	});

	test("a refresh abort rejects every waiter and permits the next refresh", async () => {
		setSystemTime(now);
		const controller = new AbortController();
		const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(
			controller.signal,
		);
		let rejectMetadata: ((reason?: unknown) => void) | undefined;
		const pending = new Promise<Response>((_resolve, reject) => {
			rejectMetadata = reject;
		});
		const fetchMock = spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("Unexpected metadata request"))
			.mockReturnValueOnce(pending);
		const s3 = new S3(config());
		const first = s3.ready();
		const second = s3.ready();
		const results = Promise.allSettled([first, second]);
		const requestSignal = fetchMock.mock.calls[0]?.[1]?.signal;
		requestSignal?.addEventListener(
			"abort",
			() => rejectMetadata?.(requestSignal.reason),
			{ once: true },
		);
		try {
			controller.abort(new DOMException("Timed out", "TimeoutError"));
			await Promise.resolve();
			expect(timeout).toHaveBeenCalledWith(5_000);
			const settled = await results;
			expect(settled.every((result) => result.status === "rejected")).toBe(
				true,
			);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(s3.config).toEqual(config());
			timeout.mockRestore();
			fetchMock
				.mockResolvedValueOnce(token())
				.mockResolvedValueOnce(role())
				.mockResolvedValueOnce(credentials());
			await s3.ready();
			expect(s3.config.accessKeyId).toBe(validCredentials.AccessKeyId);
		} finally {
			rejectMetadata?.(new Error("released test request"));
			await results;
			timeout.mockRestore();
			fetchMock.mockRestore();
		}
	});
});
