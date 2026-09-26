import { describe, expect, test } from "bun:test";
import { completeUpload, PART_RANGES, reservePartRange } from "./recovery";

const upload = {
	key: "out/job.mp4",
	uploadId: "upload",
	header: new Uint8Array([1, 2, 3]),
	payloadSize: 7,
	parts: [
		{ partNumber: 20, etag: "winner" },
		{ partNumber: 30, etag: "last" },
	],
};

function store() {
	let object: { size: number } | null = null;
	let header = upload.header;
	let completed = 0;
	let uploaded = 0;
	let lostResponse = false;
	let intent = false;
	const api = {
		async head() {
			return object;
		},
		async getRange() {
			return header;
		},
		async uploadPart() {
			expect(intent).toBe(true);
			uploaded++;
			return "header";
		},
		async completeMultipart(
			_key: string,
			_id: string,
			parts: { partNumber: number; etag: string }[],
		) {
			expect(parts).toEqual([
				{ partNumber: 1, etag: "header" },
				...upload.parts,
			]);
			completed++;
			object = { size: 10 };
			if (lostResponse) throw new Error("lost completion response");
			return true;
		},
	};
	return {
		api,
		persist: async () => {
			intent = true;
		},
		loseResponse: () => {
			lostResponse = true;
		},
		existing: (size: number, bytes = header) => {
			object = { size };
			header = bytes;
		},
		counts: () => ({ uploaded, completed }),
	};
}

describe("multipart recovery", () => {
	test("ranges never wrap after retries, including unacknowledged dispatches", () => {
		const chunk = { firstPart: 2, partLimit: 20, dispatches: 0 };
		const firstParts = new Set<number>();
		for (let i = 0; i < PART_RANGES; i++)
			firstParts.add(reservePartRange(chunk).firstPart);
		expect(firstParts.size).toBe(PART_RANGES);
		expect(() => reservePartRange(chunk)).toThrow("exhausted");
	});
	test("lost completion response is reconciled and a restart does not upload part 1 again", async () => {
		const s3 = store();
		s3.loseResponse();
		expect(await completeUpload(s3.api, upload, s3.persist)).toBe(10);
		expect(await completeUpload(s3.api, upload, s3.persist)).toBe(10);
		expect(s3.counts()).toEqual({ uploaded: 1, completed: 1 });
	});
	test("an existing object must match both accepted byte count and header", async () => {
		const s3 = store();
		s3.existing(11);
		await expect(completeUpload(s3.api, upload, s3.persist)).rejects.toThrow(
			"does not match",
		);
		s3.existing(10, new Uint8Array([3, 2, 1]));
		await expect(completeUpload(s3.api, upload, s3.persist)).rejects.toThrow(
			"does not match",
		);
		expect(s3.counts()).toEqual({ uploaded: 0, completed: 0 });
	});
	test("an undurable assembly intent cannot consume the upload", async () => {
		const s3 = store();
		await expect(
			completeUpload(s3.api, upload, async () => {
				throw new Error("journal unavailable");
			}),
		).rejects.toThrow("journal unavailable");
		expect(s3.counts()).toEqual({ uploaded: 0, completed: 0 });
	});
});
