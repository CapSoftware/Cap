import { Space } from "@cap/web-domain";
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
	it("returns typed bootstrap responses", async () => {
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
					spaces: [
						{
							id: "org_123",
							name: "All Cap",
							iconUrl: null,
							kind: "organization",
							privacy: "Public",
							role: "owner",
							canManage: true,
							hasPassword: false,
						},
						{
							id: "space_123",
							name: "Product",
							iconUrl: null,
							kind: "space",
							privacy: "Private",
							role: "member",
							canManage: false,
							hasPassword: false,
						},
					],
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
			expect(result.spaces?.[1]?.name).toBe("Product");
			expect(String(calls[0])).toBe("https://cap.so/api/mobile/bootstrap");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("requests account deletion with explicit confirmation", async () => {
		const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			calls.push({ input, init });
			return new Response(JSON.stringify({ success: true }), { status: 200 });
		}) as typeof fetch;

		try {
			const client = createMobileApiClient({
				baseUrl: "https://cap.so/",
				getToken: () => "api-key",
			});

			await expect(client.requestAccountDeletion()).resolves.toEqual({
				success: true,
			});
			expect(String(calls[0]?.input)).toBe(
				"https://cap.so/api/mobile/user/account-deletion",
			);
			expect(calls[0]?.init?.method).toBe("POST");
			expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
				confirmation: "DELETE",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("uses authenticated content safety endpoints", async () => {
		const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			calls.push({ input, init });
			return new Response(JSON.stringify({ success: true }), { status: 200 });
		}) as typeof fetch;

		try {
			const client = createMobileApiClient({
				baseUrl: "https://cap.so/",
				getToken: () => "api-key",
			});

			await client.reportCap("video_123", "harassment");
			await client.blockUser("user_456");

			expect(calls.map((call) => String(call.input))).toEqual([
				"https://cap.so/api/mobile/caps/video_123/report",
				"https://cap.so/api/mobile/user/blocks",
			]);
			expect(calls.map((call) => JSON.parse(String(call.init?.body)))).toEqual([
				{ reason: "harassment" },
				{ userId: "user_456" },
			]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("returns typed public auth provider config", async () => {
		const calls: RequestInfo[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			calls.push(input as RequestInfo);
			return new Response(
				JSON.stringify({
					appleAuthAvailable: true,
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
			expect(result.appleAuthAvailable).toBe(true);
			expect(result.googleAuthAvailable).toBe(false);
			expect(result.workosAuthAvailable).toBe(true);
			expect(String(calls[0])).toBe("https://cap.so/api/mobile/session/config");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("uses authenticated profile endpoints", async () => {
		const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			calls.push({ input, init });
			return new Response(
				JSON.stringify({
					id: "user_123",
					name: "Richie",
					lastName: "McIlroy",
					email: "richie@cap.so",
					imageUrl: null,
					activeOrganizationId: "org_123",
				}),
			);
		}) as typeof fetch;

		try {
			const client = createMobileApiClient({
				baseUrl: "https://cap.so",
				getToken: () => "api-key",
			});
			await client.updateProfile({ name: "Richie", lastName: "McIlroy" });
			await client.updateProfileImage({
				data: "iVBORw0KGgo=",
				contentType: "image/png",
				fileName: "profile.png",
			});
			await client.removeProfileImage();

			expect(calls.map((call) => String(call.input))).toEqual([
				"https://cap.so/api/mobile/user/profile",
				"https://cap.so/api/mobile/user/profile/image",
				"https://cap.so/api/mobile/user/profile/image",
			]);
			expect(calls.map((call) => call.init?.method)).toEqual([
				"PATCH",
				"PUT",
				"DELETE",
			]);
			expect(calls[0]?.init?.body).toBe(
				JSON.stringify({ name: "Richie", lastName: "McIlroy" }),
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("loads Caps from a selected space", async () => {
		const calls: RequestInfo[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			calls.push(input as RequestInfo);
			return new Response(
				JSON.stringify({
					folders: [],
					caps: [],
					page: 1,
					limit: 30,
					total: 0,
					collectionTotal: 45,
					hasMore: false,
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		try {
			const client = createMobileApiClient({
				baseUrl: "https://cap.so/",
				getToken: () => "api-key",
			});
			const result = await client.listCaps({
				folderId: null,
				spaceId: "space_123",
				page: 1,
				limit: 30,
			});

			expect(String(calls[0])).toBe(
				"https://cap.so/api/mobile/caps?spaceId=space_123&page=1&limit=30",
			);
			expect(result.collectionTotal).toBe(45);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("loads compact upload statuses in one authenticated request", async () => {
		const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			calls.push({ input, init });
			return new Response(
				JSON.stringify({
					caps: [
						{
							id: "video_123",
							upload: {
								uploaded: 500,
								total: 1000,
								phase: "uploading",
								processingProgress: 0,
								processingMessage: null,
								processingError: null,
							},
						},
					],
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		try {
			const client = createMobileApiClient({
				baseUrl: "https://cap.so/",
				getToken: () => "api-key",
			});
			const result = await client.getCapStatuses(["video_123"]);

			expect(result.caps[0]?.upload?.uploaded).toBe(500);
			expect(String(calls[0]?.input)).toBe(
				"https://cap.so/api/mobile/caps/statuses",
			);
			expect(calls[0]?.init?.method).toBe("POST");
			expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
				ids: ["video_123"],
			});
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

	it("rejects non-object success payloads", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify([]), { status: 200 })) as typeof fetch;

		try {
			const client = createMobileApiClient({
				baseUrl: "https://cap.so/",
				getToken: () => "api-key",
			});

			await expect(client.bootstrap()).rejects.toMatchObject({
				status: 502,
				payload: [],
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

	it("builds Apple session request URLs", () => {
		expect(
			createSessionRequestUrl("https://cap.so/", "cap://auth", "apple"),
		).toBe(
			"https://cap.so/api/mobile/session/request?redirectUri=cap%3A%2F%2Fauth&provider=apple",
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
				spaceId: Space.SpaceId.make("space_123"),
			});
			const body = calls[0]?.init?.body;

			expect(result.name).toBe("Product");
			expect(String(calls[0]?.input)).toBe("https://cap.so/api/mobile/folders");
			expect(calls[0]?.init?.method).toBe("POST");
			expect(typeof body).toBe("string");
			expect(JSON.parse(body as string)).toEqual({
				name: "Product",
				color: "blue",
				spaceId: "space_123",
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

		fileSystemMock.createUploadTask.mockClear();
		fileSystemMock.getInfoAsync.mockResolvedValueOnce({
			exists: true,
			isDirectory: false,
			size: 3,
			uri: "file:///tmp/video.mp4",
		});
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

	it("rejects missing local files before creating a native upload task", async () => {
		fileSystemMock.createUploadTask.mockClear();
		fileSystemMock.getInfoAsync.mockResolvedValueOnce({
			exists: false,
			isDirectory: false,
			uri: "file:///tmp/missing.mp4",
		});

		await expect(
			uploadToTarget(
				{
					type: "driveResumable",
					url: "https://uploads.example/drive",
					headers: {
						"Content-Type": "video/mp4",
					},
				},
				{
					uri: "file:///tmp/missing.mp4",
					name: "missing.mp4",
					type: "video/mp4",
					size: 3,
				},
			),
		).rejects.toThrow("The recording file is no longer available.");
		expect(fileSystemMock.createUploadTask).not.toHaveBeenCalled();
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

	it("uses authenticated native product endpoints", async () => {
		const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			calls.push({ input, init });
			const pathname = new URL(String(input)).pathname;
			if (pathname.endsWith("/analytics")) {
				return new Response(JSON.stringify({ available: false, data: null }));
			}
			if (pathname.endsWith("/imports/loom")) {
				return new Response(
					JSON.stringify({
						id: "video_456",
						shareUrl: "https://cap.so/s/video_456",
					}),
				);
			}
			return new Response(
				JSON.stringify({
					id: "org_123",
					name: "Cap",
					role: "owner",
					canManage: true,
					iconUrl: null,
					allowedEmailDomain: null,
					customDomain: null,
					domainVerified: false,
				}),
			);
		}) as typeof fetch;

		try {
			const client = createMobileApiClient({
				baseUrl: "https://cap.so",
				getToken: () => "api-key",
			});
			await client.getCapAnalytics("video_123", "30d");
			await client.updateOrganizationSettings({
				name: "Cap",
				allowedEmailDomain: null,
			});
			await client.updateOrganizationIcon({
				data: "aW1hZ2U=",
				contentType: "image/png",
				fileName: "icon.png",
			});
			await client.removeOrganizationIcon();
			await client.importLoom("https://www.loom.com/share/abcdefghij");

			expect(String(calls[0]?.input)).toBe(
				"https://cap.so/api/mobile/caps/video_123/analytics?range=30d",
			);
			expect(calls.map((call) => call.init?.method)).toEqual([
				"GET",
				"PATCH",
				"PUT",
				"DELETE",
				"POST",
			]);
			expect(String(calls[4]?.input)).toBe(
				"https://cap.so/api/mobile/imports/loom",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
