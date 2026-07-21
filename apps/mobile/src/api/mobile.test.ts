import { describe, expect, it, vi } from "vitest";
import {
	createMobileApiClient,
	createSessionRequestUrl,
	uploadToTarget,
} from "./mobile";

const fileSystemMock = vi.hoisted(() => ({
	FileSystemUploadType: {
		BINARY_CONTENT: 0,
		MULTIPART: 1,
	},
	createUploadTask: vi.fn(),
	getInfoAsync: vi.fn(),
}));

vi.mock("expo-file-system/legacy", () => fileSystemMock);

describe("createMobileApiClient", () => {
	it("decodes bootstrap responses through shared schemas", async () => {
		const calls: RequestInfo[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			calls.push(input as RequestInfo);
			return new Response(
				JSON.stringify({
					user: {
						id: "user_123",
						name: "Richie",
						email: "richie@example.com",
						imageUrl: null,
						activeOrganizationId: "org_123",
					},
					organizations: [
						{
							id: "org_123",
							name: "Cap",
							iconUrl: null,
							role: "owner",
						},
					],
					activeOrganizationId: "org_123",
					rootFolders: [],
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		try {
			const client = createMobileApiClient({
				baseUrl: "https://cap.so/",
				getToken: () => "api-key",
			});
			const result = await client.bootstrap();
			expect(result.user.email).toBe("richie@example.com");
			expect(String(calls[0])).toBe("https://cap.so/api/mobile/bootstrap");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("decodes public auth provider config", async () => {
		const calls: RequestInfo[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			calls.push(input as RequestInfo);
			return new Response(
				JSON.stringify({
					googleAuthAvailable: false,
					workosAuthAvailable: true,
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		try {
			const client = createMobileApiClient({
				baseUrl: "https://cap.so/",
				getToken: () => null,
			});
			const result = await client.getAuthConfig();
			expect(result.googleAuthAvailable).toBe(false);
			expect(result.workosAuthAvailable).toBe(true);
			expect(String(calls[0])).toBe("https://cap.so/api/mobile/session/config");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("keeps non-JSON error responses in the API error payload", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("<html>bad gateway</html>", {
				status: 502,
			})) as typeof fetch;

		try {
			const client = createMobileApiClient({
				baseUrl: "https://cap.so/",
				getToken: () => "api-key",
			});

			await expect(client.bootstrap()).rejects.toMatchObject({
				status: 502,
				payload: "<html>bad gateway</html>",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("builds Google session request URLs", () => {
		expect(
			createSessionRequestUrl("https://cap.so/", "cap://auth", "google"),
		).toBe(
			"https://cap.so/api/mobile/session/request?redirectUri=cap%3A%2F%2Fauth&provider=google",
		);
	});

	it("builds WorkOS session request URLs", () => {
		expect(
			createSessionRequestUrl(
				"https://cap.so/",
				"cap://auth",
				"workos",
				"org_123",
			),
		).toBe(
			"https://cap.so/api/mobile/session/request?redirectUri=cap%3A%2F%2Fauth&provider=workos&organizationId=org_123",
		);
	});

	it("updates Cap sharing with the authenticated PATCH endpoint", async () => {
		const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			calls.push({ input, init });
			return new Response(
				JSON.stringify({
					id: "video_123",
					shareUrl: "https://cap.so/s/video_123",
					title: "Launch review",
					createdAt: "2026-05-18T10:00:00.000Z",
					updatedAt: "2026-05-18T10:30:00.000Z",
					ownerName: "Richie",
					durationSeconds: null,
					thumbnailUrl: null,
					folderId: null,
					public: false,
					protected: false,
					viewCount: 0,
					commentCount: 0,
					reactionCount: 0,
					upload: null,
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		try {
			const client = createMobileApiClient({
				baseUrl: "https://cap.so/",
				getToken: () => "api-key",
			});
			const result = await client.updateCapSharing("video_123", {
				public: false,
			});
			const body = calls[0]?.init?.body;

			expect(result.public).toBe(false);
			expect(String(calls[0]?.input)).toBe(
				"https://cap.so/api/mobile/caps/video_123/sharing",
			);
			expect(calls[0]?.init?.method).toBe("PATCH");
			expect(calls[0]?.init?.headers).toBeInstanceOf(Headers);
			expect((calls[0]?.init?.headers as Headers).get("authorization")).toBe(
				"Bearer api-key",
			);
			expect(typeof body).toBe("string");
			expect(JSON.parse(body as string)).toEqual({ public: false });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("creates folders with the authenticated POST endpoint", async () => {
		const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			calls.push({ input, init });
			return new Response(
				JSON.stringify({
					id: "folder_123",
					name: "Product",
					color: "blue",
					parentId: null,
					videoCount: 0,
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		try {
			const client = createMobileApiClient({
				baseUrl: "https://cap.so/",
				getToken: () => "api-key",
			});
			const result = await client.createFolder({
				name: "Product",
				color: "blue",
			});
			const body = calls[0]?.init?.body;

			expect(result.name).toBe("Product");
			expect(String(calls[0]?.input)).toBe("https://cap.so/api/mobile/folders");
			expect(calls[0]?.init?.method).toBe("POST");
			expect(typeof body).toBe("string");
			expect(JSON.parse(body as string)).toEqual({
				name: "Product",
				color: "blue",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("updates Cap titles with the authenticated PATCH endpoint", async () => {
		const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			calls.push({ input, init });
			return new Response(
				JSON.stringify({
					id: "video_123",
					shareUrl: "https://cap.so/s/video_123",
					title: "Roadmap review",
					createdAt: "2026-05-18T10:00:00.000Z",
					updatedAt: "2026-05-18T10:30:00.000Z",
					ownerName: "Richie",
					durationSeconds: null,
					thumbnailUrl: null,
					folderId: null,
					public: true,
					protected: false,
					viewCount: 0,
					commentCount: 0,
					reactionCount: 0,
					upload: null,
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		try {
			const client = createMobileApiClient({
				baseUrl: "https://cap.so/",
				getToken: () => "api-key",
			});
			const result = await client.updateCapTitle("video_123", {
				title: "Roadmap review",
			});
			const body = calls[0]?.init?.body;

			expect(result.title).toBe("Roadmap review");
			expect(String(calls[0]?.input)).toBe(
				"https://cap.so/api/mobile/caps/video_123/title",
			);
			expect(calls[0]?.init?.method).toBe("PATCH");
			expect(typeof body).toBe("string");
			expect(JSON.parse(body as string)).toEqual({ title: "Roadmap review" });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("requests segmented recording targets and completes separate media tracks", async () => {
		const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			calls.push({ input, init });
			if (String(input).endsWith("/segments/targets")) {
				return new Response(
					JSON.stringify({
						uploads: {
							"segments/video/init.mp4": {
								type: "put",
								url: "https://uploads.example/video-init",
								headers: { "Content-Type": "video/mp4" },
							},
						},
					}),
					{ status: 200 },
				);
			}
			return new Response(JSON.stringify({ success: true }), { status: 200 });
		}) as typeof fetch;

		try {
			const client = createMobileApiClient({
				baseUrl: "https://cap.so/",
				getToken: () => "api-key",
			});
			const targets = await client.createRecordingUploadTargets("video_123", [
				"segments/video/init.mp4",
			]);
			await client.completeRecording("video_123", {
				durationSeconds: 2,
				totalBytes: 650_500,
				videoSegments: [{ index: 1, duration: 2 }],
				audioSegments: [{ index: 1, duration: 2 }],
			});

			expect(targets.uploads["segments/video/init.mp4"]?.type).toBe("put");
			expect(String(calls[0]?.input)).toBe(
				"https://cap.so/api/mobile/recordings/video_123/segments/targets",
			);
			expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
				subpaths: ["segments/video/init.mp4"],
			});
			expect(String(calls[1]?.input)).toBe(
				"https://cap.so/api/mobile/recordings/video_123/complete",
			);
			expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
				durationSeconds: 2,
				totalBytes: 650_500,
				videoSegments: [{ index: 1, duration: 2 }],
				audioSegments: [{ index: 1, duration: 2 }],
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("updates Cap passwords with the authenticated PATCH endpoint", async () => {
		const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			calls.push({ input, init });
			return new Response(
				JSON.stringify({
					id: "video_123",
					shareUrl: "https://cap.so/s/video_123",
					title: "Launch review",
					createdAt: "2026-05-18T10:00:00.000Z",
					updatedAt: "2026-05-18T10:30:00.000Z",
					ownerName: "Richie",
					durationSeconds: null,
					thumbnailUrl: null,
					folderId: null,
					public: true,
					protected: true,
					viewCount: 0,
					commentCount: 0,
					reactionCount: 0,
					upload: null,
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		try {
			const client = createMobileApiClient({
				baseUrl: "https://cap.so/",
				getToken: () => "api-key",
			});
			const result = await client.updateCapPassword("video_123", {
				password: "secret",
			});
			const body = calls[0]?.init?.body;

			expect(result.protected).toBe(true);
			expect(String(calls[0]?.input)).toBe(
				"https://cap.so/api/mobile/caps/video_123/password",
			);
			expect(calls[0]?.init?.method).toBe("PATCH");
			expect(typeof body).toBe("string");
			expect(JSON.parse(body as string)).toEqual({ password: "secret" });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("uploads local files with native transfer progress", async () => {
		const uploadAsync = vi.fn(() =>
			Promise.resolve({
				body: "",
				headers: {},
				mimeType: null,
				status: 200,
			}),
		);
		const onProgress = vi.fn();

		fileSystemMock.createUploadTask.mockImplementation(
			(
				url: string,
				fileUri: string,
				options: unknown,
				callback?: (data: {
					totalBytesExpectedToSend: number;
					totalBytesSent: number;
				}) => void,
			) => {
				callback?.({
					totalBytesExpectedToSend: 3,
					totalBytesSent: 2,
				});
				return { uploadAsync, url, fileUri, options };
			},
		);

		await uploadToTarget(
			{
				type: "driveResumable",
				url: "https://uploads.example/drive",
				headers: {
					"Content-Type": "video/mp4",
				},
			},
			{
				uri: "file:///tmp/video.mp4",
				name: "video.mp4",
				type: "video/mp4",
				size: 3,
			},
			onProgress,
		);

		expect(fileSystemMock.createUploadTask).toHaveBeenCalledWith(
			"https://uploads.example/drive",
			"file:///tmp/video.mp4",
			{
				headers: {
					"Content-Range": "bytes 0-2/3",
					"Content-Type": "video/mp4",
				},
				httpMethod: "PUT",
				uploadType: fileSystemMock.FileSystemUploadType.BINARY_CONTENT,
			},
			expect.any(Function),
		);
		expect(uploadAsync).toHaveBeenCalled();
		expect(onProgress).toHaveBeenCalledWith({ loaded: 2, total: 3 });
	});

	it("sets the Drive resumable upload byte range for remote blobs", async () => {
		class MockXMLHttpRequest {
			static instances: MockXMLHttpRequest[] = [];
			upload: {
				onprogress:
					| ((event: ProgressEvent<XMLHttpRequestEventTarget>) => void)
					| null;
			} = { onprogress: null };
			status = 200;
			responseText = "";
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			method = "";
			url = "";
			headers = new Map<string, string>();
			body: BodyInit | null = null;

			constructor() {
				MockXMLHttpRequest.instances.push(this);
			}

			open(method: string, url: string) {
				this.method = method;
				this.url = url;
			}

			setRequestHeader(key: string, value: string) {
				this.headers.set(key, value);
			}

			send(body: BodyInit) {
				this.body = body;
				this.onload?.();
			}
		}

		const originalFetch = globalThis.fetch;
		const originalXhr = globalThis.XMLHttpRequest;
		globalThis.fetch = (async () =>
			new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;
		globalThis.XMLHttpRequest =
			MockXMLHttpRequest as unknown as typeof XMLHttpRequest;

		try {
			await uploadToTarget(
				{
					type: "driveResumable",
					url: "https://uploads.example/drive",
					headers: {
						"Content-Type": "video/mp4",
					},
				},
				{
					uri: "https://cache.example/video.mp4",
					name: "video.mp4",
					type: "video/mp4",
					size: 3,
				},
			);

			const request = MockXMLHttpRequest.instances[0];
			expect(request?.method).toBe("PUT");
			expect(request?.headers.get("content-type")).toBe("video/mp4");
			expect(request?.headers.get("content-range")).toBe("bytes 0-2/3");
		} finally {
			globalThis.fetch = originalFetch;
			globalThis.XMLHttpRequest = originalXhr;
		}
	});
});
