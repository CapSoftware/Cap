import { beforeEach, describe, expect, mock, test } from "bun:test";
import app from "../../app";
import * as ffmpegVideo from "../../lib/ffmpeg-video";
import * as ffprobe from "../../lib/ffprobe";
import * as jobManager from "../../lib/job-manager";

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

	test("returns 400 for missing videoUrl", async () => {
		const response = await app.fetch(
			new Request("http://localhost/video/probe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			}),
		);

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns 400 for invalid URL format", async () => {
		const response = await app.fetch(
			new Request("http://localhost/video/probe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ videoUrl: "not-a-valid-url" }),
			}),
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

		mock.module("../../lib/ffprobe", () => ({
			probeVideo: async () => mockMetadata,
			canAcceptNewProbeProcess: ffprobe.canAcceptNewProbeProcess,
			getActiveProbeProcessCount: ffprobe.getActiveProbeProcessCount,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			new Request("http://localhost/video/probe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ videoUrl: "https://example.com/video.mp4" }),
			}),
		);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.metadata).toEqual(mockMetadata);
	});

	test("returns 503 when server is busy", async () => {
		mock.module("../../lib/ffprobe", () => ({
			probeVideo: async () => {
				throw new Error("Server is busy, please try again later");
			},
			canAcceptNewProbeProcess: ffprobe.canAcceptNewProbeProcess,
			getActiveProbeProcessCount: ffprobe.getActiveProbeProcessCount,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			new Request("http://localhost/video/probe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ videoUrl: "https://example.com/video.mp4" }),
			}),
		);

		expect(response.status).toBe(503);
		const data = await response.json();
		expect(data.code).toBe("SERVER_BUSY");
	});

	test("returns 504 when probe times out", async () => {
		mock.module("../../lib/ffprobe", () => ({
			probeVideo: async () => {
				throw new Error("Operation timed out after 30000ms");
			},
			canAcceptNewProbeProcess: ffprobe.canAcceptNewProbeProcess,
			getActiveProbeProcessCount: ffprobe.getActiveProbeProcessCount,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			new Request("http://localhost/video/probe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ videoUrl: "https://example.com/video.mp4" }),
			}),
		);

		expect(response.status).toBe(504);
		const data = await response.json();
		expect(data.code).toBe("TIMEOUT");
	});

	test("returns 500 when ffprobe fails", async () => {
		mock.module("../../lib/ffprobe", () => ({
			probeVideo: async () => {
				throw new Error("ffprobe failed: no such file");
			},
			canAcceptNewProbeProcess: ffprobe.canAcceptNewProbeProcess,
			getActiveProbeProcessCount: ffprobe.getActiveProbeProcessCount,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			new Request("http://localhost/video/probe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ videoUrl: "https://example.com/video.mp4" }),
			}),
		);

		expect(response.status).toBe(500);
		const data = await response.json();
		expect(data.code).toBe("FFPROBE_ERROR");
		expect(data.details).toContain("ffprobe failed");
	});
});

describe("POST /video/thumbnail", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("returns 400 for missing videoUrl", async () => {
		const response = await app.fetch(
			new Request("http://localhost/video/thumbnail", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			}),
		);

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns 400 for invalid URL format", async () => {
		const response = await app.fetch(
			new Request("http://localhost/video/thumbnail", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ videoUrl: "not-a-url" }),
			}),
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

		mock.module("../../lib/ffprobe", () => ({
			probeVideo: async () => mockMetadata,
			canAcceptNewProbeProcess: ffprobe.canAcceptNewProbeProcess,
			getActiveProbeProcessCount: ffprobe.getActiveProbeProcessCount,
		}));

		mock.module("../../lib/ffmpeg-video", () => ({
			generateThumbnail: async () => mockThumbnailData,
			downloadVideoToTemp: ffmpegVideo.downloadVideoToTemp,
			processVideo: ffmpegVideo.processVideo,
			uploadToS3: ffmpegVideo.uploadToS3,
			uploadFileToS3: ffmpegVideo.uploadFileToS3,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			new Request("http://localhost/video/thumbnail", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ videoUrl: "https://example.com/video.mp4" }),
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

describe("POST /video/process", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("returns 400 for missing required fields", async () => {
		const response = await app.fetch(
			new Request("http://localhost/video/process", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			}),
		);

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns 400 for missing videoUrl", async () => {
		const response = await app.fetch(
			new Request("http://localhost/video/process", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					videoId: "test-id",
					userId: "user-id",
					outputPresignedUrl: "https://s3.example.com/output",
				}),
			}),
		);

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns 400 for invalid outputPresignedUrl", async () => {
		const response = await app.fetch(
			new Request("http://localhost/video/process", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					videoId: "test-id",
					userId: "user-id",
					videoUrl: "https://example.com/video.mp4",
					outputPresignedUrl: "not-a-url",
				}),
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
			getAllJobs: jobManager.getAllJobs,
			generateJobId: jobManager.generateJobId,
			createJob: jobManager.createJob,
			incrementActiveVideoProcesses: jobManager.incrementActiveVideoProcesses,
			decrementActiveVideoProcesses: jobManager.decrementActiveVideoProcesses,
			getJob: jobManager.getJob,
			updateJob: jobManager.updateJob,
			deleteJob: jobManager.deleteJob,
			sendWebhook: jobManager.sendWebhook,
			getJobProgress: jobManager.getJobProgress,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			new Request("http://localhost/video/process", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					videoId: "test-id",
					userId: "user-id",
					videoUrl: "https://example.com/video.mp4",
					outputPresignedUrl: "https://s3.example.com/output",
				}),
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
			incrementActiveVideoProcesses: () => {},
			decrementActiveVideoProcesses: () => {},
			getJob: () => null,
			updateJob: () => null,
			deleteJob: () => {},
			sendWebhook: async () => {},
			getJobProgress: jobManager.getJobProgress,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			new Request("http://localhost/video/process", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					videoId: "test-id",
					userId: "user-id",
					videoUrl: "https://example.com/video.mp4",
					outputPresignedUrl: "https://s3.example.com/output",
				}),
			}),
		);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.jobId).toBe("test-job-id");
		expect(data.status).toBe("queued");
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
			getAllJobs: () => [],
			generateJobId: () => "test-job-id",
			createJob: jobManager.createJob,
			incrementActiveVideoProcesses: () => {},
			decrementActiveVideoProcesses: () => {},
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
			getJobProgress: (job: any) => ({
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
			getAllJobs: () => [],
			generateJobId: () => "test-job-id",
			createJob: jobManager.createJob,
			incrementActiveVideoProcesses: () => {},
			decrementActiveVideoProcesses: () => {},
			getJob: () => null,
			updateJob: () => null,
			deleteJob: () => {},
			sendWebhook: async () => {},
			getJobProgress: jobManager.getJobProgress,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			new Request("http://localhost/video/process/nonexistent-job/cancel", {
				method: "POST",
			}),
		);

		expect(response.status).toBe(404);
		const data = await response.json();
		expect(data.code).toBe("NOT_FOUND");
	});

	test("returns 400 when trying to cancel completed job", async () => {
		mock.module("../../lib/job-manager", () => ({
			canAcceptNewVideoProcess: () => true,
			getActiveVideoProcessCount: () => 0,
			getAllJobs: () => [],
			generateJobId: () => "test-job-id",
			createJob: jobManager.createJob,
			incrementActiveVideoProcesses: () => {},
			decrementActiveVideoProcesses: () => {},
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
			new Request("http://localhost/video/process/test-job-id/cancel", {
				method: "POST",
			}),
		);

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_STATE");
		expect(data.currentPhase).toBe("complete");
	});

	test("successfully cancels running job", async () => {
		const abortController = new AbortController();
		let abortCalled = false;

		mock.module("../../lib/job-manager", () => ({
			canAcceptNewVideoProcess: () => true,
			getActiveVideoProcessCount: () => 0,
			getAllJobs: () => [],
			generateJobId: () => "test-job-id",
			createJob: jobManager.createJob,
			incrementActiveVideoProcesses: () => {},
			decrementActiveVideoProcesses: () => {},
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
			new Request("http://localhost/video/process/test-job-id/cancel", {
				method: "POST",
			}),
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
			new Request("http://localhost/video/cleanup", {
				method: "POST",
			}),
		);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.success).toBe(true);
		expect(data.cleanedFiles).toBe(5);
	});
});
