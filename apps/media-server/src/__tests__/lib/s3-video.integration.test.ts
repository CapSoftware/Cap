import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	downloadVideoToTemp,
	generateThumbnail,
	processVideo,
	uploadToS3,
} from "../../lib/ffmpeg-video";
import { probeVideo } from "../../lib/ffprobe";

const S3_ENDPOINT = process.env.S3_TEST_ENDPOINT || "http://localhost:9000";
const S3_ACCESS_KEY = process.env.S3_TEST_ACCESS_KEY || "capS3root";
const S3_SECRET_KEY = process.env.S3_TEST_SECRET_KEY || "capS3root";
const S3_BUCKET = process.env.S3_TEST_BUCKET || "capso";
const S3_REGION = process.env.S3_TEST_REGION || "us-east-1";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const TEST_VIDEO_WITH_AUDIO = join(FIXTURES_DIR, "test-with-audio.mp4");
const TEST_VIDEO_NO_AUDIO = join(FIXTURES_DIR, "test-no-audio.mp4");

const TEST_VIDEO_KEY = "test-videos/integration-test-video.mp4";
const TEST_VIDEO_NO_AUDIO_KEY =
	"test-videos/integration-test-video-no-audio.mp4";

const tempFiles: string[] = [];

async function getPresignedUploadUrl(key: string): Promise<string> {
	const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
	const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");

	const client = new S3Client({
		endpoint: S3_ENDPOINT,
		region: S3_REGION,
		credentials: {
			accessKeyId: S3_ACCESS_KEY,
			secretAccessKey: S3_SECRET_KEY,
		},
		forcePathStyle: true,
	});

	const command = new PutObjectCommand({
		Bucket: S3_BUCKET,
		Key: key,
		ContentType: "video/mp4",
	});

	return getSignedUrl(client, command, { expiresIn: 3600 });
}

async function getPresignedDownloadUrl(key: string): Promise<string> {
	const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
	const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");

	const client = new S3Client({
		endpoint: S3_ENDPOINT,
		region: S3_REGION,
		credentials: {
			accessKeyId: S3_ACCESS_KEY,
			secretAccessKey: S3_SECRET_KEY,
		},
		forcePathStyle: true,
	});

	const command = new GetObjectCommand({
		Bucket: S3_BUCKET,
		Key: key,
	});

	return getSignedUrl(client, command, { expiresIn: 3600 });
}

async function uploadTestVideo(localPath: string, key: string): Promise<void> {
	const videoData = readFileSync(localPath);
	const presignedUrl = await getPresignedUploadUrl(key);
	await uploadToS3(new Uint8Array(videoData), presignedUrl, "video/mp4");
}

async function deleteTestVideo(key: string): Promise<void> {
	const { S3Client, DeleteObjectCommand } = await import("@aws-sdk/client-s3");

	const client = new S3Client({
		endpoint: S3_ENDPOINT,
		region: S3_REGION,
		credentials: {
			accessKeyId: S3_ACCESS_KEY,
			secretAccessKey: S3_SECRET_KEY,
		},
		forcePathStyle: true,
	});

	try {
		await client.send(
			new DeleteObjectCommand({
				Bucket: S3_BUCKET,
				Key: key,
			}),
		);
	} catch {}
}

async function checkS3Available(): Promise<boolean> {
	try {
		const { S3Client, HeadBucketCommand } = await import("@aws-sdk/client-s3");

		const client = new S3Client({
			endpoint: S3_ENDPOINT,
			region: S3_REGION,
			credentials: {
				accessKeyId: S3_ACCESS_KEY,
				secretAccessKey: S3_SECRET_KEY,
			},
			forcePathStyle: true,
		});

		await client.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
		return true;
	} catch {
		return false;
	}
}

describe("S3/MinIO Video Integration Tests", () => {
	let s3Available = false;

	beforeAll(async () => {
		s3Available = await checkS3Available();
		if (!s3Available) {
			console.log(
				"Skipping S3 integration tests - S3/MinIO not available at",
				S3_ENDPOINT,
			);
			return;
		}

		console.log("Uploading test videos to S3...");
		await Promise.all([
			uploadTestVideo(TEST_VIDEO_WITH_AUDIO, TEST_VIDEO_KEY),
			uploadTestVideo(TEST_VIDEO_NO_AUDIO, TEST_VIDEO_NO_AUDIO_KEY),
		]);
		console.log("Test videos uploaded successfully");
	});

	afterAll(async () => {
		for (const file of tempFiles) {
			if (existsSync(file)) {
				rmSync(file);
			}
		}

		if (s3Available) {
			console.log("Cleaning up test videos from S3...");
			await Promise.all([
				deleteTestVideo(TEST_VIDEO_KEY),
				deleteTestVideo(TEST_VIDEO_NO_AUDIO_KEY),
			]);
		}
	});

	describe("downloadVideoToTemp from S3", () => {
		test("downloads video with audio from S3", async () => {
			if (!s3Available) return;

			const videoUrl = await getPresignedDownloadUrl(TEST_VIDEO_KEY);
			const tempFile = await downloadVideoToTemp(videoUrl);
			tempFiles.push(tempFile.path);

			expect(existsSync(tempFile.path)).toBe(true);

			const originalSize = readFileSync(TEST_VIDEO_WITH_AUDIO).length;
			const downloadedSize = readFileSync(tempFile.path).length;
			expect(downloadedSize).toBe(originalSize);

			await tempFile.cleanup();
		}, 30000);

		test("downloads video without audio from S3", async () => {
			if (!s3Available) return;

			const videoUrl = await getPresignedDownloadUrl(TEST_VIDEO_NO_AUDIO_KEY);
			const tempFile = await downloadVideoToTemp(videoUrl);
			tempFiles.push(tempFile.path);

			expect(existsSync(tempFile.path)).toBe(true);

			await tempFile.cleanup();
		}, 30000);
	});

	describe("probeVideo from S3", () => {
		test("probes video metadata from S3 URL", async () => {
			if (!s3Available) return;

			const videoUrl = await getPresignedDownloadUrl(TEST_VIDEO_KEY);
			const metadata = await probeVideo(videoUrl);

			expect(metadata.duration).toBeGreaterThan(0);
			expect(metadata.width).toBeGreaterThan(0);
			expect(metadata.height).toBeGreaterThan(0);
			expect(metadata.videoCodec).toBeTruthy();
			expect(metadata.audioCodec).toBeTruthy();
		}, 30000);

		test("probes video without audio from S3", async () => {
			if (!s3Available) return;

			const videoUrl = await getPresignedDownloadUrl(TEST_VIDEO_NO_AUDIO_KEY);
			const metadata = await probeVideo(videoUrl);

			expect(metadata.duration).toBeGreaterThan(0);
			expect(metadata.videoCodec).toBeTruthy();
		}, 30000);
	});

	describe("processVideo from S3", () => {
		test("downloads and processes video from S3", async () => {
			if (!s3Available) return;

			const videoUrl = await getPresignedDownloadUrl(TEST_VIDEO_KEY);
			const downloadedFile = await downloadVideoToTemp(videoUrl);
			tempFiles.push(downloadedFile.path);

			const metadata = await probeVideo(`file://${downloadedFile.path}`);

			const progressUpdates: number[] = [];
			const processedFile = await processVideo(
				downloadedFile.path,
				metadata,
				{ maxWidth: 640, maxHeight: 360 },
				(progress) => {
					progressUpdates.push(progress);
				},
			);
			tempFiles.push(processedFile.path);

			expect(existsSync(processedFile.path)).toBe(true);

			const outputMetadata = await probeVideo(`file://${processedFile.path}`);
			expect(outputMetadata.width).toBeLessThanOrEqual(640);
			expect(outputMetadata.height).toBeLessThanOrEqual(360);
			expect(outputMetadata.videoCodec).toBe("h264");

			await downloadedFile.cleanup();
			await processedFile.cleanup();
		}, 120000);

		test("processes video and uploads result back to S3", async () => {
			if (!s3Available) return;

			const videoUrl = await getPresignedDownloadUrl(TEST_VIDEO_KEY);
			const downloadedFile = await downloadVideoToTemp(videoUrl);
			tempFiles.push(downloadedFile.path);

			const metadata = await probeVideo(`file://${downloadedFile.path}`);

			const processedFile = await processVideo(downloadedFile.path, metadata, {
				maxWidth: 480,
				maxHeight: 270,
				crf: 28,
			});
			tempFiles.push(processedFile.path);

			const outputKey = "test-videos/processed-output.mp4";
			const uploadUrl = await getPresignedUploadUrl(outputKey);
			const processedData = readFileSync(processedFile.path);
			await uploadToS3(new Uint8Array(processedData), uploadUrl, "video/mp4");

			const downloadUrl = await getPresignedDownloadUrl(outputKey);
			const redownloadedFile = await downloadVideoToTemp(downloadUrl);
			tempFiles.push(redownloadedFile.path);

			expect(existsSync(redownloadedFile.path)).toBe(true);
			const redownloadedMetadata = await probeVideo(
				`file://${redownloadedFile.path}`,
			);
			expect(redownloadedMetadata.width).toBeLessThanOrEqual(480);
			expect(redownloadedMetadata.height).toBeLessThanOrEqual(270);

			await deleteTestVideo(outputKey);
			await downloadedFile.cleanup();
			await processedFile.cleanup();
			await redownloadedFile.cleanup();
		}, 180000);
	});

	describe("generateThumbnail from S3 video", () => {
		test("generates thumbnail from S3 video", async () => {
			if (!s3Available) return;

			const videoUrl = await getPresignedDownloadUrl(TEST_VIDEO_KEY);
			const downloadedFile = await downloadVideoToTemp(videoUrl);
			tempFiles.push(downloadedFile.path);

			const metadata = await probeVideo(`file://${downloadedFile.path}`);

			const thumbnail = await generateThumbnail(
				downloadedFile.path,
				metadata.duration,
				{ width: 320, height: 180 },
			);

			expect(thumbnail).toBeInstanceOf(Uint8Array);
			expect(thumbnail.length).toBeGreaterThan(0);

			expect(thumbnail[0]).toBe(0xff);
			expect(thumbnail[1]).toBe(0xd8);

			await downloadedFile.cleanup();
		}, 60000);

		test("generates and uploads thumbnail to S3", async () => {
			if (!s3Available) return;

			const videoUrl = await getPresignedDownloadUrl(TEST_VIDEO_KEY);
			const downloadedFile = await downloadVideoToTemp(videoUrl);
			tempFiles.push(downloadedFile.path);

			const metadata = await probeVideo(`file://${downloadedFile.path}`);

			const thumbnail = await generateThumbnail(
				downloadedFile.path,
				metadata.duration,
			);

			const thumbnailKey = "test-videos/thumbnail.jpg";
			const uploadUrl = await getPresignedUploadUrl(thumbnailKey);
			await uploadToS3(thumbnail, uploadUrl, "image/jpeg");

			const downloadUrl = await getPresignedDownloadUrl(thumbnailKey);
			const response = await fetch(downloadUrl);
			expect(response.ok).toBe(true);
			const downloaded = new Uint8Array(await response.arrayBuffer());
			expect(downloaded[0]).toBe(0xff);
			expect(downloaded[1]).toBe(0xd8);

			await deleteTestVideo(thumbnailKey);
			await downloadedFile.cleanup();
		}, 60000);
	});

	describe("end-to-end video pipeline", () => {
		test("complete video processing pipeline with S3", async () => {
			if (!s3Available) return;

			const inputUrl = await getPresignedDownloadUrl(TEST_VIDEO_KEY);

			const downloadedFile = await downloadVideoToTemp(inputUrl);
			tempFiles.push(downloadedFile.path);

			const metadata = await probeVideo(`file://${downloadedFile.path}`);
			expect(metadata.duration).toBeGreaterThan(0);

			const processedFile = await processVideo(downloadedFile.path, metadata, {
				maxWidth: 640,
				maxHeight: 360,
				preset: "fast",
			});
			tempFiles.push(processedFile.path);

			const outputKey = "test-videos/pipeline-output.mp4";
			const uploadUrl = await getPresignedUploadUrl(outputKey);
			const processedData = readFileSync(processedFile.path);
			await uploadToS3(new Uint8Array(processedData), uploadUrl, "video/mp4");

			const verifyUrl = await getPresignedDownloadUrl(outputKey);
			const outputMetadata = await probeVideo(verifyUrl);
			expect(outputMetadata.videoCodec).toBe("h264");
			expect(outputMetadata.width).toBeLessThanOrEqual(640);

			await deleteTestVideo(outputKey);
			await downloadedFile.cleanup();
			await processedFile.cleanup();
		}, 180000);
	});
});
