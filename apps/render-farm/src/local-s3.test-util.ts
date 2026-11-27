import { S3, type S3Config } from "./s3";

const servers: ReturnType<typeof Bun.serve>[] = [];

export function localServer(
	handle: (request: Request) => Response | Promise<Response>,
) {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

export function localS3(
	handle: (request: Request) => Response | Promise<Response>,
	config: Partial<S3Config> = {},
) {
	return new S3({
		region: "us-east-1",
		bucket: "bucket",
		accessKeyId: "a",
		secretAccessKey: "b",
		virtualHost: false,
		...config,
		endpoint: localServer(handle),
	});
}

export function stopLocalS3() {
	for (const server of servers.splice(0)) server.stop(true);
}

export type StoredObject = {
	body: Uint8Array<ArrayBuffer>;
	contentType: string | null;
};

export function memoryBucket(
	bucket = "bucket",
	options: {
		before?: (
			request: Request,
			key: string,
		) => Response | undefined | Promise<Response | undefined>;
	} = {},
) {
	const objects = new Map<string, StoredObject>();
	const requests: string[] = [];
	const uploads = new Map<
		string,
		{ key: string; contentType: string | null; parts: Map<number, Uint8Array> }
	>();
	let nextUpload = 0;
	const handle = async (request: Request) => {
		const url = new URL(request.url);
		const prefix = `/${bucket}/`;
		if (!url.pathname.startsWith(prefix)) {
			return new Response("<Error><Code>NoSuchBucket</Code></Error>", {
				status: 404,
			});
		}
		const key = decodeURIComponent(url.pathname.slice(prefix.length));
		requests.push(`${request.method} ${key}`);
		const answered = await options.before?.(request, key);
		if (answered) return answered;
		const uploadId = url.searchParams.get("uploadId");
		if (request.method === "POST" && url.searchParams.has("uploads")) {
			const id = `upload-${nextUpload++}`;
			uploads.set(id, {
				key,
				contentType: request.headers.get("content-type"),
				parts: new Map(),
			});
			return new Response(
				`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
			);
		}
		if (uploadId !== null) {
			const upload = uploads.get(uploadId);
			if (!upload || upload.key !== key) {
				return new Response("<Error><Code>NoSuchUpload</Code></Error>", {
					status: 404,
				});
			}
			if (request.method === "PUT") {
				const partNumber = Number(url.searchParams.get("partNumber"));
				upload.parts.set(
					partNumber,
					new Uint8Array(await request.arrayBuffer()),
				);
				return new Response(null, { headers: { etag: `"${partNumber}"` } });
			}
			if (request.method === "DELETE") {
				uploads.delete(uploadId);
				return new Response(null, { status: 204 });
			}
			if (request.method !== "POST") {
				return new Response(null, { status: 405 });
			}
			if (request.headers.get("if-none-match") === "*" && objects.has(key)) {
				return new Response("<Error><Code>PreconditionFailed</Code></Error>", {
					status: 412,
				});
			}
			const listed = [
				...(await request.text()).matchAll(/<PartNumber>(\d+)<\/PartNumber>/g),
			].map((match) => upload.parts.get(Number(match[1])));
			if (listed.some((part) => !part)) {
				return new Response("<Error><Code>InvalidPart</Code></Error>", {
					status: 400,
				});
			}
			const parts = listed as Uint8Array[];
			const body = new Uint8Array(
				parts.reduce((sum, part) => sum + part.byteLength, 0),
			);
			let offset = 0;
			for (const part of parts) {
				body.set(part, offset);
				offset += part.byteLength;
			}
			objects.set(key, { body, contentType: upload.contentType });
			uploads.delete(uploadId);
			return new Response(
				"<CompleteMultipartUploadResult></CompleteMultipartUploadResult>",
			);
		}
		if (request.method === "PUT") {
			objects.set(key, {
				body: new Uint8Array(await request.arrayBuffer()),
				contentType: request.headers.get("content-type"),
			});
			return new Response(null, { status: 200 });
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response(null, { status: 405 });
		}
		const object = objects.get(key);
		if (!object) {
			return new Response("<Error><Code>NoSuchKey</Code></Error>", {
				status: 404,
			});
		}
		const size = object.body.byteLength;
		const range = /^bytes=(\d+)-(\d*)$/.exec(
			request.headers.get("range") ?? "",
		);
		if (request.method === "HEAD") {
			return new Response(null, {
				headers: { "accept-ranges": "bytes", "content-length": String(size) },
			});
		}
		if (!range) {
			return new Response(object.body, {
				headers: { "accept-ranges": "bytes" },
			});
		}
		const start = Number(range[1]);
		const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
		if (start >= size) {
			return new Response(null, {
				status: 416,
				headers: { "content-range": `bytes */${size}` },
			});
		}
		return new Response(object.body.subarray(start, end + 1), {
			status: 206,
			headers: {
				"accept-ranges": "bytes",
				"content-range": `bytes ${start}-${end}/${size}`,
			},
		});
	};
	return { objects, requests, handle };
}
