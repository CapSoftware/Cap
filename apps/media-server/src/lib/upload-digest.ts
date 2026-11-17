import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export type UploadDigestMode = "none" | "whole" | { partSize: number };

// S3 answers a PUT with the MD5 of the bytes it stored, and a multipart upload with the MD5 of its parts' MD5s
// plus the part count. Computing the same tag from the local file lets an upload whose ETag matches it skip
// reading the whole object back; any other ETag (SSE-KMS, Drive, other providers) keeps the full re-read.
export async function digestUploadFile(
	path: string,
	mode: UploadDigestMode,
	signal?: AbortSignal,
): Promise<{ sha256: string; contentIdentity?: string }> {
	const sha256 = createHash("sha256");
	const whole = mode === "whole" ? createHash("md5") : null;
	const partSize = typeof mode === "object" ? mode.partSize : undefined;
	const partDigests: Buffer[] = [];
	let part = partSize !== undefined ? createHash("md5") : null;
	let partBytes = 0;
	for await (const chunk of createReadStream(path, { signal })) {
		const bytes = chunk as Buffer;
		sha256.update(bytes);
		whole?.update(bytes);
		if (!part || partSize === undefined) continue;
		let offset = 0;
		while (offset < bytes.length) {
			const take = Math.min(partSize - partBytes, bytes.length - offset);
			part.update(bytes.subarray(offset, offset + take));
			partBytes += take;
			offset += take;
			if (partBytes === partSize) {
				partDigests.push(part.digest());
				part = createHash("md5");
				partBytes = 0;
			}
		}
	}
	if (part && partBytes > 0) partDigests.push(part.digest());
	let contentIdentity: string | undefined;
	if (whole) contentIdentity = `"${whole.digest("hex")}"`;
	else if (partDigests.length > 0)
		contentIdentity = `"${createHash("md5").update(Buffer.concat(partDigests)).digest("hex")}-${partDigests.length}"`;
	return { sha256: sha256.digest("hex"), contentIdentity };
}

export function parseUploadDigestMode(value: string | undefined) {
	if (value === "none" || value === "whole") return value;
	const partSize = Number(value);
	if (!Number.isSafeInteger(partSize) || partSize <= 0)
		throw new Error("Invalid upload digest mode");
	return { partSize };
}

if (import.meta.main) {
	try {
		const path = process.argv[2];
		if (!path) throw new Error("Missing upload digest path");
		console.log(
			JSON.stringify(
				await digestUploadFile(path, parseUploadDigestMode(process.argv[3])),
			),
		);
	} catch {
		console.log(JSON.stringify({ error: "unavailable" }));
		process.exitCode = 1;
	}
}
