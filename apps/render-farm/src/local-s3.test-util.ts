import { S3, type S3Config } from "./s3";

const servers: ReturnType<typeof Bun.serve>[] = [];

export function localS3(
	handle: (request: Request) => Response | Promise<Response>,
	config: Partial<S3Config> = {},
) {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
	servers.push(server);
	return new S3({
		region: "us-east-1",
		bucket: "bucket",
		accessKeyId: "a",
		secretAccessKey: "b",
		virtualHost: false,
		...config,
		endpoint: `http://127.0.0.1:${server.port}`,
	});
}

export function stopLocalS3() {
	for (const server of servers.splice(0)) server.stop(true);
}

export type StoredObject = {
	body: Uint8Array<ArrayBuffer>;
	contentType: string | null;
};

/** A path-style S3 bucket kept in memory: PUT, and GET with byte ranges. */
export function memoryBucket(bucket = "bucket") {
	const objects = new Map<string, StoredObject>();
	const requests: string[] = [];
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
		if (request.method === "PUT") {
			objects.set(key, {
				body: new Uint8Array(await request.arrayBuffer()),
				contentType: request.headers.get("content-type"),
			});
			return new Response(null, { status: 200 });
		}
		if (request.method !== "GET") {
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
