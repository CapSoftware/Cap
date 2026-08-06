import { beforeEach, describe, expect, mock, test } from "bun:test";
import app from "../../app";
import * as jobManager from "../../lib/job-manager";
import * as mediaProbe from "../../lib/media-probe";
import * as mediaVideo from "../../lib/media-video";
import {
	getMaxConcurrentDirectVideoProcesses,
	tryAcquireDirectVideoProcessSlot,
	type VideoProcessSlot,
} from "../../lib/video-capacity";

const MEDIA_SERVER_SECRET = "test-secret";
const AUTH_HEADERS = {
	"Content-Type": "application/json",
	"x-media-server-secret": MEDIA_SERVER_SECRET,
};

process.env.MEDIA_SERVER_WEBHOOK_SECRET = MEDIA_SERVER_SECRET;

function videoPostRequest(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: AUTH_HEADERS,
		body: JSON.stringify(body),
	});
}

function unauthenticatedVideoPostRequest(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("GET /video/status", () => {
	test("returns server status", async () => {
		const response = await app.fetch(
			new Request("http://localhost/video/status", {
				method: "GET",
			}),
		);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data).toHaveProperty("activeVideoProcesses");
		expect(data).toHaveProperty("activeProbeProcesses");
		expect(data).toHaveProperty("activeDirectVideoProcesses");
		expect(data).toHaveProperty("maxConcurrentDirectVideoProcesses");
		expect(data).toHaveProperty("canAcceptNewVideoProcess");
		expect(data).toHaveProperty("canAcceptNewProbeProcess");
		expect(data).toHaveProperty("jobCount");
		expect(data).toHaveProperty("jobs");
		expect(Array.isArray(data.jobs)).toBe(true);
	});
});

describe("POST /video/probe", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("returns 401 without media server secret", async () => {
		const response = await app.fetch(
			unauthenticatedVideoPostRequest("/video/probe", {
				videoUrl: "https://example.com/video.mp4",
			}),
		);

		expect(response.status).toBe(401);
	});

	test("returns 400 for missing videoUrl", async () => {
		const response = await app.fetch(videoPostRequest("/video/probe", {}));

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns 400 for invalid URL format", async () => {
		const response = await app.fetch(
			videoPostRequest("/video/probe", { videoUrl: "not-a-valid-url" }),
		);

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns metadata when probe succeeds", async () => {
		const mockMetadata = {
			duration: 10.5,
			width: 1920,
			height: 1080,
			fps: 30,
			videoCodec: "h264",
			audioCodec: "aac",
			audioChannels: 2,
			sampleRate: 48000,
			bitrate: 5000000,
			fileSize: 6553600,
		};

		mock.module("../../lib/media-probe", () => ({
			...mediaProbe,
			probeVideo: async () => mockMetadata,
			canAcceptNewProbeProcess: mediaProbe.canAcceptNewProbeProcess,
			getActiveProbeProcessCount: mediaProbe.getActiveProbeProcessCount,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			videoPostRequest("/video/probe", {
				videoUrl: "https://example.com/video.mp4",
			}),
		);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.metadata).toEqual(mockMetadata);
	});

	test("returns 503 when server is busy", async () => {
		mock.module("../../lib/media-probe", () => ({
			...mediaProbe,
			probeVideo: async () => {
				throw new Error("Server is busy, please try again later");
			},
			canAcceptNewProbeProcess: mediaProbe.canAcceptNewProbeProcess,
			getActiveProbeProcessCount: mediaProbe.getActiveProbeProcessCount,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			videoPostRequest("/video/probe", {
				videoUrl: "https://example.com/video.mp4",
			}),
		);

		expect(response.status).toBe(503);
		const data = await response.json();
		expect(data.code).toBe("SERVER_BUSY");
	});

	test("returns 504 when probe times out", async () => {
		mock.module("../../lib/media-probe", () => ({
			...mediaProbe,
			probeVideo: async () => {
				throw new Error("Operation timed out after 30000ms");
			},
			canAcceptNewProbeProcess: mediaProbe.canAcceptNewProbeProcess,
			getActiveProbeProcessCount: mediaProbe.getActiveProbeProcessCount,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			videoPostRequest("/video/probe", {
				videoUrl: "https://example.com/video.mp4",
			}),
		);

		expect(response.status).toBe(504);
		const data = await response.json();
		expect(data.code).toBe("TIMEOUT");
	});

	test("returns 500 when mediaProbe fails", async () => {
		mock.module("../../lib/media-probe", () => ({
			...mediaProbe,
			probeVideo: async () => {
				throw new Error("mediaProbe failed: no such file");
			},
			canAcceptNewProbeProcess: mediaProbe.canAcceptNewProbeProcess,
			getActiveProbeProcessCount: mediaProbe.getActiveProbeProcessCount,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			videoPostRequest("/video/probe", {
				videoUrl: "https://example.com/video.mp4",
			}),
		);

		expect(response.status).toBe(500);
		const data = await response.json();
		expect(data.code).toBe(["FF", "PROBE_ERROR"].join(""));
		expect(data.details).toContain("mediaProbe failed");
	});
});

describe("POST /video/thumbnail", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("returns 401 without media server secret", async () => {
		const response = await app.fetch(
			unauthenticatedVideoPostRequest("/video/thumbnail", {
				videoUrl: "https://example.com/video.mp4",
			}),
		);

		expect(response.status).toBe(401);
	});

	test("returns 400 for missing videoUrl", async () => {
		const response = await app.fetch(videoPostRequest("/video/thumbnail", {}));

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns 400 for invalid URL format", async () => {
		const response = await app.fetch(
			videoPostRequest("/video/thumbnail", { videoUrl: "not-a-url" }),
		);

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns thumbnail image when generation succeeds", async () => {
		const mockThumbnailData = new Uint8Array([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
		]);
		const mockMetadata = {
			duration: 10.5,
			width: 1920,
			height: 1080,
			fps: 30,
			videoCodec: "h264",
			audioCodec: null,
			audioChannels: null,
			sampleRate: null,
			bitrate: 5000000,
			fileSize: 6553600,
		};

		mock.module("../../lib/media-probe", () => ({
			...mediaProbe,
			probeVideo: async () => mockMetadata,
			canAcceptNewProbeProcess: mediaProbe.canAcceptNewProbeProcess,
			getActiveProbeProcessCount: mediaProbe.getActiveProbeProcessCount,
		}));

		mock.module("../../lib/media-video", () => ({
			...mediaVideo,
			generateThumbnail: async () => mockThumbnailData,
			downloadVideoToTemp: mediaVideo.downloadVideoToTemp,
			processVideo: mediaVideo.processVideo,
			uploadToS3: mediaVideo.uploadToS3,
			uploadFileToS3: mediaVideo.uploadFileToS3,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			videoPostRequest("/video/thumbnail", {
				videoUrl: "https://example.com/video.mp4",
			}),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("image/jpeg");
		expect(response.headers.get("Content-Length")).toBe(
			mockThumbnailData.length.toString(),
		);

		const buffer = await response.arrayBuffer();
		expect(new Uint8Array(buffer)).toEqual(mockThumbnailData);
	});
});

describe("POST /video/convert", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("returns 401 without media server secret", async () => {
		const response = await app.fetch(
			unauthenticatedVideoPostRequest("/video/convert", {
				videoUrl: "https://example.com/video.m3u8",
			}),
		);

		expect(response.status).toBe(401);
	});

	test("returns 400 for missing videoUrl", async () => {
		const response = await app.fetch(videoPostRequest("/video/convert", {}));

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns 503 before downloading when video capacity is exhausted", async () => {
		const slots: VideoProcessSlot[] = [];
		try {
			const directLimit = getMaxConcurrentDirectVideoProcesses();
			for (let i = 0; i < directLimit; i++) {
				const slot = tryAcquireDirectVideoProcessSlot(
					jobManager.canAcceptNewVideoProcess,
				);
				expect(slot).not.toBeNull();
				if (slot) slots.push(slot);
			}

			expect(slots.length).toBe(directLimit);

			const response = await app.fetch(
				videoPostRequest("/video/convert", {
					videoUrl: "https://example.com/video.m3u8",
					inputExtension: ".m3u8",
				}),
			);

			expect(response.status).toBe(503);
			expect(response.headers.get("Retry-After")).toBe("15");
			const data = await response.json();
			expect(data.code).toBe("SERVER_BUSY");
			expect(data.activeDirectVideoProcesses).toBe(directLimit);
			expect(data.maxConcurrentDirectVideoProcesses).toBe(directLimit);
		} finally {
			for (const slot of slots) {
				slot.release();
			}
		}
	});

	test("returns mp4 when conversion succeeds", async () => {
		const fixturePath = new URL(
			"../fixtures/test-with-audio.mp4",
			import.meta.url,
		).pathname;
		const fixtureBytes = await Bun.file(fixturePath).bytes();
		const mockMetadata = {
			duration: 10.5,
			width: 1280,
			height: 720,
			fps: 30,
			videoCodec: "h264",
			audioCodec: "aac",
			audioChannels: 2,
			sampleRate: 48000,
			bitrate: 5000000,
			fileSize: fixtureBytes.length,
		};

		mock.module("../../lib/media-probe", () => ({
			...mediaProbe,
			probeVideo: mediaProbe.probeVideo,
			probeVideoFile: async () => mockMetadata,
			canAcceptNewProbeProcess: mediaProbe.canAcceptNewProbeProcess,
			getActiveProbeProcessCount: mediaProbe.getActiveProbeProcessCount,
		}));

		mock.module("../../lib/media-video", () => ({
			...mediaVideo,
			downloadVideoToTemp: async () => ({
				path: fixturePath,
				cleanup: async () => {},
			}),
			processVideo: async () => ({
				path: fixturePath,
				cleanup: async () => {},
			}),
			generateThumbnail: mediaVideo.generateThumbnail,
			repairContainer: mediaVideo.repairContainer,
			uploadToS3: mediaVideo.uploadToS3,
			uploadFileToS3: mediaVideo.uploadFileToS3,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			videoPostRequest("/video/convert", {
				videoUrl: "https://example.com/video.m3u8",
				inputExtension: ".m3u8",
			}),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("video/mp4");
		expect(response.headers.get("Content-Length")).toBe(
			fixtureBytes.length.toString(),
		);

		const buffer = await response.arrayBuffer();
		expect(new Uint8Array(buffer)).toEqual(fixtureBytes);
	});
});

describe("POST /video/process", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("returns 400 for missing required fields", async () => {
		const response = await app.fetch(videoPostRequest("/video/process", {}));

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns 400 for missing videoUrl", async () => {
		const response = await app.fetch(
			videoPostRequest("/video/process", {
				videoId: "test-id",
				userId: "user-id",
				outputPresignedUrl: "https://s3.example.com/output",
			}),
		);

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns 400 for invalid outputPresignedUrl", async () => {
		const response = await app.fetch(
			videoPostRequest("/video/process", {
				videoId: "test-id",
				userId: "user-id",
				videoUrl: "https://example.com/video.mp4",
				outputPresignedUrl: "not-a-url",
			}),
		);

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns 503 when server is busy", async () => {
		mock.module("../../lib/job-manager", () => ({
			canAcceptNewVideoProcess: () => false,
			getActiveVideoProcessCount: jobManager.getActiveVideoProcessCount,
			getMaxConcurrentVideoProcesses: jobManager.getMaxConcurrentVideoProcesses,
			getSystemResources: jobManager.getSystemResources,
			getAllJobs: jobManager.getAllJobs,
			generateJobId: jobManager.generateJobId,
			createJob: jobManager.createJob,
			getJob: jobManager.getJob,
			updateJob: jobManager.updateJob,
			deleteJob: jobManager.deleteJob,
			sendWebhook: jobManager.sendWebhook,
			getJobProgress: jobManager.getJobProgress,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			videoPostRequest("/video/process", {
				videoId: "test-id",
				userId: "user-id",
				videoUrl: "https://example.com/video.mp4",
				outputPresignedUrl: "https://s3.example.com/output",
			}),
		);

		expect(response.status).toBe(503);
		const data = await response.json();
		expect(data.code).toBe("SERVER_BUSY");
	});

	test("returns jobId when process starts successfully", async () => {
		mock.module("../../lib/job-manager", () => ({
			canAcceptNewVideoProcess: () => true,
			getActiveVideoProcessCount: () => 0,
			getMaxConcurrentVideoProcesses: () => 3,
			getSystemResources: jobManager.getSystemResources,
			getAllJobs: () => [],
			generateJobId: () => "test-job-id",
			createJob: () => ({
				jobId: "test-job-id",
				videoId: "test-id",
				userId: "user-id",
				phase: "queued",
				progress: 0,
				createdAt: new Date(),
				updatedAt: new Date(),
			}),
			getJob: () => null,
			updateJob: () => null,
			deleteJob: () => {},
			sendWebhook: async () => {},
			getJobProgress: jobManager.getJobProgress,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			videoPostRequest("/video/process", {
				videoId: "test-id",
				userId: "user-id",
				videoUrl: "https://example.com/video.mp4",
				outputPresignedUrl: "https://s3.example.com/output",
			}),
		);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.jobId).toBe("test-job-id");
		expect(data.status).toBe("queued");
	});
});

describe("POST /video/edit", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("returns 401 without media server secret", async () => {
		const response = await app.fetch(
			unauthenticatedVideoPostRequest("/video/edit", {
				videoId: "test-id",
				userId: "user-id",
				sourceUrl: "https://example.com/source.mp4",
				outputPresignedUrl: "https://s3.example.com/output",
				keepRanges: [{ start: 0, end: 1 }],
			}),
		);

		expect(response.status).toBe(401);
	});

	test("returns 400 for invalid JSON", async () => {
		const response = await app.fetch(
			new Request("http://localhost/video/edit", {
				method: "POST",
				headers: AUTH_HEADERS,
				body: "{",
			}),
		);

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns 400 for missing keep ranges", async () => {
		const response = await app.fetch(
			videoPostRequest("/video/edit", {
				videoId: "test-id",
				userId: "user-id",
				sourceUrl: "https://example.com/source.mp4",
				outputPresignedUrl: "https://s3.example.com/output",
			}),
		);

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns 400 for invalid ranges", async () => {
		const response = await app.fetch(
			videoPostRequest("/video/edit", {
				videoId: "test-id",
				userId: "user-id",
				sourceUrl: "https://example.com/source.mp4",
				outputPresignedUrl: "https://s3.example.com/output",
				keepRanges: [{ start: 3, end: 1 }],
			}),
		);

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns jobId when edit starts successfully", async () => {
		mock.module("../../lib/job-manager", () => ({
			canAcceptNewVideoProcess: () => true,
			getActiveVideoProcessCount: () => 0,
			getMaxConcurrentVideoProcesses: () => 3,
			getSystemResources: jobManager.getSystemResources,
			getAllJobs: () => [],
			generateJobId: () => "edit-job-id",
			createJob: () => ({
				jobId: "edit-job-id",
				videoId: "test-id",
				userId: "user-id",
				phase: "queued",
				progress: 0,
				createdAt: new Date(),
				updatedAt: new Date(),
			}),
			getJob: () => null,
			updateJob: () => null,
			deleteJob: () => {},
			sendWebhook: async () => {},
			getJobProgress: jobManager.getJobProgress,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			videoPostRequest("/video/edit", {
				videoId: "test-id",
				userId: "user-id",
				sourceUrl: "https://example.com/source.mp4",
				outputPresignedUrl: "https://s3.example.com/output",
				keepRanges: [{ start: 0, end: 1 }],
			}),
		);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.jobId).toBe("edit-job-id");
		expect(data.status).toBe("queued");
	});
});

describe("POST /video/mux-segments", () => {
	beforeEach(() => {
		mock.restore();
	});

	const baseMuxBody = {
		videoId: "test-id",
		userId: "user-id",
		videoInitUrl: "https://example.com/video/init.mp4",
		videoSegmentUrls: ["https://example.com/video/segment-1.m4s"],
	};

	test("returns 400 when output upload target is missing", async () => {
		const response = await app.fetch(
			videoPostRequest("/video/mux-segments", baseMuxBody),
		);

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.error).toBe("Invalid request");
	});

	test("accepts multipart output upload target", async () => {
		mock.module("../../lib/job-manager", () => ({
			...jobManager,
			canAcceptNewVideoProcess: () => false,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			videoPostRequest("/video/mux-segments", {
				...baseMuxBody,
				outputUpload: {
					type: "multipart",
					videoId: "test-id",
					key: "user-id/test-id/result.mp4",
					uploadId: "upload-id",
					partSize: 5 * 1024 * 1024,
					signPartUrl:
						"https://cap.example.com/api/webhooks/media-server/multipart/sign-part",
					completeUrl:
						"https://cap.example.com/api/webhooks/media-server/multipart/complete",
					abortUrl:
						"https://cap.example.com/api/webhooks/media-server/multipart/abort",
					webhookSecret: MEDIA_SERVER_SECRET,
				},
			}),
		);

		expect(response.status).toBe(503);
		const data = await response.json();
		expect(data.code).toBe("SERVER_BUSY");
	});
});

describe("GET /video/process/:jobId/status", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("returns 404 for non-existent job", async () => {
		const response = await app.fetch(
			new Request("http://localhost/video/process/nonexistent-job/status", {
				method: "GET",
			}),
		);

		expect(response.status).toBe(404);
		const data = await response.json();
		expect(data.code).toBe("NOT_FOUND");
	});

	test("returns job progress when job exists", async () => {
		mock.module("../../lib/job-manager", () => ({
			canAcceptNewVideoProcess: () => true,
			getActiveVideoProcessCount: () => 0,
			getMaxConcurrentVideoProcesses: () => 3,
			getSystemResources: jobManager.getSystemResources,
			getAllJobs: () => [],
			generateJobId: () => "test-job-id",
			createJob: jobManager.createJob,
			getJob: () => ({
				jobId: "test-job-id",
				videoId: "test-video",
				userId: "test-user",
				phase: "processing",
				progress: 50,
				message: "Processing video...",
				createdAt: new Date(),
				updatedAt: new Date(),
			}),
			updateJob: () => null,
			deleteJob: () => {},
			sendWebhook: async () => {},
			getJobProgress: (job: {
				phase: string;
				progress: number;
				message?: string;
			}) => ({
				phase: job.phase,
				progress: job.progress,
				message: job.message,
			}),
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			new Request("http://localhost/video/process/test-job-id/status", {
				method: "GET",
			}),
		);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.phase).toBe("processing");
		expect(data.progress).toBe(50);
	});
});

describe("POST /video/process/:jobId/cancel", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("returns 404 for non-existent job", async () => {
		mock.module("../../lib/job-manager", () => ({
			canAcceptNewVideoProcess: () => true,
			getActiveVideoProcessCount: () => 0,
			getMaxConcurrentVideoProcesses: () => 3,
			getSystemResources: jobManager.getSystemResources,
			getAllJobs: () => [],
			generateJobId: () => "test-job-id",
			createJob: jobManager.createJob,
			getJob: () => null,
			updateJob: () => null,
			deleteJob: () => {},
			sendWebhook: async () => {},
			getJobProgress: jobManager.getJobProgress,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			videoPostRequest("/video/process/nonexistent-job/cancel", {}),
		);

		expect(response.status).toBe(404);
		const data = await response.json();
		expect(data.code).toBe("NOT_FOUND");
	});

	test("returns 400 when trying to cancel completed job", async () => {
		mock.module("../../lib/job-manager", () => ({
			canAcceptNewVideoProcess: () => true,
			getActiveVideoProcessCount: () => 0,
			getMaxConcurrentVideoProcesses: () => 3,
			getSystemResources: jobManager.getSystemResources,
			getAllJobs: () => [],
			generateJobId: () => "test-job-id",
			createJob: jobManager.createJob,
			getJob: () => ({
				jobId: "test-job-id",
				videoId: "test-video",
				userId: "test-user",
				phase: "complete",
				progress: 100,
				createdAt: new Date(),
				updatedAt: new Date(),
			}),
			updateJob: () => null,
			deleteJob: () => {},
			sendWebhook: async () => {},
			getJobProgress: jobManager.getJobProgress,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			videoPostRequest("/video/process/test-job-id/cancel", {}),
		);

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_STATE");
		expect(data.currentPhase).toBe("complete");
	});

	test("successfully cancels running job", async () => {
		let abortCalled = false;

		mock.module("../../lib/job-manager", () => ({
			canAcceptNewVideoProcess: () => true,
			getActiveVideoProcessCount: () => 0,
			getMaxConcurrentVideoProcesses: () => 3,
			getSystemResources: jobManager.getSystemResources,
			getAllJobs: () => [],
			generateJobId: () => "test-job-id",
			createJob: jobManager.createJob,
			getJob: () => ({
				jobId: "test-job-id",
				videoId: "test-video",
				userId: "test-user",
				phase: "processing",
				progress: 50,
				createdAt: new Date(),
				updatedAt: new Date(),
				abortController: {
					abort: () => {
						abortCalled = true;
					},
				},
			}),
			updateJob: () => null,
			deleteJob: () => {},
			sendWebhook: async () => {},
			getJobProgress: jobManager.getJobProgress,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			videoPostRequest("/video/process/test-job-id/cancel", {}),
		);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.success).toBe(true);
		expect(abortCalled).toBe(true);
	});
});

describe("POST /video/cleanup", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("returns cleanup result", async () => {
		mock.module("../../lib/temp-files", () => ({
			cleanupStaleTempFiles: async () => 5,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			videoPostRequest("/video/cleanup", {}),
		);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.success).toBe(true);
		expect(data.cleanedFiles).toBe(5);
	});
});
