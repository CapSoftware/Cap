import { createHash, createHmac } from "node:crypto";

// Minimal SigV4 S3 client. Bun's built-in client can't upload a multipart
// part under a caller-chosen part number, which is the whole trick here:
// every chunk worker PUTs its bytes straight into the final object's
// multipart upload, so assembly never moves video data again.

export type S3Config = {
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	virtualHost: boolean;
	/** Use the EC2 instance role (IMDSv2) instead of static keys. */
	imds?: boolean;
};

export function s3ConfigFromEnv(env = process.env): S3Config {
	const required = (name: string) => {
		const value = env[name];
		if (!value) throw new Error(`${name} is not set`);
		return value;
	};
	const imds = env.RF_S3_IMDS === "1";
	return {
		endpoint: required("RF_S3_ENDPOINT"),
		region: env.RF_S3_REGION || "auto",
		bucket: required("RF_S3_BUCKET"),
		accessKeyId: imds ? "" : required("RF_S3_ACCESS_KEY_ID"),
		secretAccessKey: imds ? "" : required("RF_S3_SECRET_ACCESS_KEY"),
		virtualHost: env.RF_S3_URL_STYLE !== "path",
		imds,
	};
}

const EMPTY_SHA = createHash("sha256").update("").digest("hex");

function encodeKey(key: string) {
	return key
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
}

function hmac(key: Buffer | string, value: string) {
	return createHmac("sha256", key).update(value).digest();
}

export class S3 {
	private expiresAt = 0;
	private fetchedAt = 0;
	private refreshing: Promise<void> | null = null;

	constructor(readonly config: S3Config) {}

	/** Refresh instance-role credentials from IMDSv2 when close to expiry. */
	/**
	 * Presigns with credentials refreshed first. A URL signed with instance-role
	 * credentials stops working when they expire, so its lifetime is capped at
	 * theirs (up to ~6 h after issue); longer-lived playback needs a CDN.
	 */
	async presignFresh(method: string, key: string, expiresSeconds: number) {
		await this.ready(Math.min(expiresSeconds * 1000, 60 * 60_000));
		const remaining = this.config.imds
			? Math.floor((this.expiresAt - Date.now()) / 1000) - 60
			: expiresSeconds;
		return this.presign(
			method,
			key,
			Math.max(60, Math.min(expiresSeconds, remaining)),
		);
	}

	async ready(minRemainingMs = 5 * 60_000) {
		if (!this.config.imds || Date.now() < this.expiresAt - minRemainingMs)
			return;
		// Instance credentials rotate on AWS's schedule; asking again sooner
		// returns the same ones, so only the hard 5 min floor forces a fetch.
		if (
			Date.now() - this.fetchedAt < 60_000 &&
			Date.now() < this.expiresAt - 5 * 60_000
		) {
			return;
		}
		this.refreshing ??= (async () => {
			const token = await (
				await fetch("http://169.254.169.254/latest/api/token", {
					method: "PUT",
					headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" },
				})
			).text();
			const headers = { "x-aws-ec2-metadata-token": token };
			const base =
				"http://169.254.169.254/latest/meta-data/iam/security-credentials/";
			const role = (await (await fetch(base, { headers })).text())
				.trim()
				.split("\n")[0];
			const credentials = (await (
				await fetch(`${base}${role}`, { headers })
			).json()) as {
				AccessKeyId: string;
				SecretAccessKey: string;
				Token: string;
				Expiration: string;
			};
			this.config.accessKeyId = credentials.AccessKeyId;
			this.config.secretAccessKey = credentials.SecretAccessKey;
			this.config.sessionToken = credentials.Token;
			this.expiresAt = Date.parse(credentials.Expiration);
			this.fetchedAt = Date.now();
		})().finally(() => {
			this.refreshing = null;
		});
		await this.refreshing;
	}

	private target(key: string) {
		const endpoint = new URL(this.config.endpoint);
		if (this.config.virtualHost) {
			return {
				host: `${this.config.bucket}.${endpoint.host}`,
				path: `/${encodeKey(key)}`,
				origin: `${endpoint.protocol}//${this.config.bucket}.${endpoint.host}`,
			};
		}
		return {
			host: endpoint.host,
			path: `/${this.config.bucket}/${encodeKey(key)}`,
			origin: `${endpoint.protocol}//${endpoint.host}`,
		};
	}

	private signingKey(date: string) {
		const kDate = hmac(`AWS4${this.config.secretAccessKey}`, date);
		const kRegion = hmac(kDate, this.config.region);
		const kService = hmac(kRegion, "s3");
		return hmac(kService, "aws4_request");
	}

	private canonicalQuery(query: Record<string, string>) {
		return Object.keys(query)
			.sort()
			.map(
				(name) =>
					`${encodeURIComponent(name)}=${encodeURIComponent(query[name] ?? "")}`,
			)
			.join("&");
	}

	sign(
		method: string,
		key: string,
		query: Record<string, string> = {},
		headers: Record<string, string> = {},
		payloadHash = "UNSIGNED-PAYLOAD",
	) {
		const { host, path, origin } = this.target(key);
		const now = new Date();
		const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
		const date = amzDate.slice(0, 8);
		const all: Record<string, string> = {
			...Object.fromEntries(
				Object.entries(headers).map(([name, value]) => [
					name.toLowerCase(),
					value,
				]),
			),
			host,
			"x-amz-date": amzDate,
			"x-amz-content-sha256": payloadHash,
			...(this.config.sessionToken
				? { "x-amz-security-token": this.config.sessionToken }
				: {}),
		};
		const names = Object.keys(all).sort();
		const canonicalHeaders = names
			.map((name) => `${name}:${String(all[name]).trim()}\n`)
			.join("");
		const signedHeaders = names.join(";");
		const canonicalQuery = this.canonicalQuery(query);
		const canonical = [
			method,
			path,
			canonicalQuery,
			canonicalHeaders,
			signedHeaders,
			payloadHash,
		].join("\n");
		const scope = `${date}/${this.config.region}/s3/aws4_request`;
		const toSign = [
			"AWS4-HMAC-SHA256",
			amzDate,
			scope,
			createHash("sha256").update(canonical).digest("hex"),
		].join("\n");
		const signature = createHmac("sha256", this.signingKey(date))
			.update(toSign)
			.digest("hex");
		const { host: _host, ...sendHeaders } = all;
		return {
			url: `${origin}${path}${canonicalQuery ? `?${canonicalQuery}` : ""}`,
			headers: {
				...sendHeaders,
				authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
			},
		};
	}

	presign(
		method: string,
		key: string,
		expiresSeconds = 3600,
		query: Record<string, string> = {},
	) {
		const { host, path, origin } = this.target(key);
		const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
		const date = amzDate.slice(0, 8);
		const scope = `${date}/${this.config.region}/s3/aws4_request`;
		const all = {
			...query,
			"X-Amz-Algorithm": "AWS4-HMAC-SHA256",
			"X-Amz-Credential": `${this.config.accessKeyId}/${scope}`,
			"X-Amz-Date": amzDate,
			"X-Amz-Expires": String(expiresSeconds),
			"X-Amz-SignedHeaders": "host",
			...(this.config.sessionToken
				? { "X-Amz-Security-Token": this.config.sessionToken }
				: {}),
		};
		const canonicalQuery = this.canonicalQuery(all);
		const canonical = [
			method,
			path,
			canonicalQuery,
			`host:${host}\n`,
			"host",
			"UNSIGNED-PAYLOAD",
		].join("\n");
		const toSign = [
			"AWS4-HMAC-SHA256",
			amzDate,
			scope,
			createHash("sha256").update(canonical).digest("hex"),
		].join("\n");
		const signature = createHmac("sha256", this.signingKey(date))
			.update(toSign)
			.digest("hex");
		return `${origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
	}

	private async send(
		method: string,
		key: string,
		options: {
			query?: Record<string, string>;
			headers?: Record<string, string>;
			body?: Uint8Array | string;
			expect?: number[];
		} = {},
	) {
		const payloadHash =
			options.body === undefined
				? EMPTY_SHA
				: typeof options.body === "string"
					? createHash("sha256").update(options.body).digest("hex")
					: "UNSIGNED-PAYLOAD";
		await this.ready();
		for (let attempt = 0; ; attempt++) {
			const signed = this.sign(
				method,
				key,
				options.query,
				options.headers,
				payloadHash,
			);
			let response: Response;
			try {
				response = await fetch(signed.url, {
					method,
					headers: signed.headers,
					body: options.body as BodyInit | undefined,
				});
			} catch (error) {
				// Object stores drop connections under bursty fan-out; back off
				// with jitter rather than failing the chunk.
				if (attempt < 8) {
					await Bun.sleep(
						Math.min(8000, 250 * 2 ** attempt) * (0.5 + Math.random()),
					);
					continue;
				}
				throw error;
			}
			const expect = options.expect ?? [200, 204, 206];
			if (expect.includes(response.status)) return response;
			const text = await response.text();
			if (
				(response.status >= 500 ||
					response.status === 429 ||
					response.status === 408) &&
				attempt < 8
			) {
				await Bun.sleep(
					Math.min(8000, 250 * 2 ** attempt) * (0.5 + Math.random()),
				);
				continue;
			}
			throw new Error(
				`S3 ${method} ${key} -> ${response.status}: ${text.slice(0, 300)}`,
			);
		}
	}

	async head(key: string) {
		const response = await this.send("HEAD", key, { expect: [200, 404] });
		if (response.status === 404) return null;
		return { size: Number(response.headers.get("content-length") ?? 0) };
	}

	async getRange(key: string, start: number, endInclusive: number) {
		const response = await this.send("GET", key, {
			headers: { range: `bytes=${start}-${endInclusive}` },
		});
		return new Uint8Array(await response.arrayBuffer());
	}

	async getStream(key: string, start?: number, endInclusive?: number) {
		const response = await this.send("GET", key, {
			headers:
				start === undefined
					? {}
					: { range: `bytes=${start}-${endInclusive ?? ""}` },
		});
		if (!response.body) throw new Error(`S3 GET ${key} returned no body`);
		return response.body;
	}

	async get(key: string) {
		const response = await this.send("GET", key);
		return new Uint8Array(await response.arrayBuffer());
	}

	async put(key: string, body: Uint8Array | string, contentType?: string) {
		await this.send("PUT", key, {
			body,
			headers: contentType ? { "content-type": contentType } : {},
		});
	}

	async createMultipart(key: string, contentType: string) {
		const response = await this.send("POST", key, {
			query: { uploads: "" },
			headers: { "content-type": contentType },
		});
		const text = await response.text();
		const match = text.match(/<UploadId>([^<]+)<\/UploadId>/);
		if (!match?.[1]) throw new Error(`no UploadId in ${text.slice(0, 200)}`);
		return match[1];
	}

	async uploadPart(
		key: string,
		uploadId: string,
		partNumber: number,
		body: Uint8Array,
	) {
		const response = await this.send("PUT", key, {
			query: { partNumber: String(partNumber), uploadId },
			body,
		});
		const etag = response.headers.get("etag");
		if (!etag) throw new Error(`no ETag for part ${partNumber}`);
		return etag;
	}

	async completeMultipart(
		key: string,
		uploadId: string,
		parts: { partNumber: number; etag: string }[],
	) {
		const body = `<CompleteMultipartUpload>${parts
			.sort((a, b) => a.partNumber - b.partNumber)
			.map(
				(part) =>
					`<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag}</ETag></Part>`,
			)
			.join("")}</CompleteMultipartUpload>`;
		const response = await this.send("POST", key, {
			query: { uploadId },
			body,
			headers: { "content-type": "application/xml" },
		});
		const text = await response.text();
		if (text.includes("<Error>")) {
			throw new Error(`complete multipart failed: ${text.slice(0, 300)}`);
		}
	}

	async listParts(key: string, uploadId: string) {
		const parts: { partNumber: number; etag: string; size: number }[] = [];
		let marker = "0";
		for (;;) {
			const response = await this.send("GET", key, {
				query: { uploadId, "max-parts": "1000", "part-number-marker": marker },
			});
			const text = await response.text();
			for (const match of text.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
				const body = match[1] ?? "";
				parts.push({
					partNumber: Number(
						body.match(/<PartNumber>(\d+)<\/PartNumber>/)?.[1],
					),
					etag: decodeXml(body.match(/<ETag>([^<]+)<\/ETag>/)?.[1] ?? ""),
					size: Number(body.match(/<Size>(\d+)<\/Size>/)?.[1]),
				});
			}
			const next = text.match(
				/<NextPartNumberMarker>(\d+)<\/NextPartNumberMarker>/,
			)?.[1];
			if (!/<IsTruncated>true<\/IsTruncated>/.test(text) || !next) break;
			marker = next;
		}
		return parts;
	}

	async abortMultipart(key: string, uploadId: string) {
		await this.send("DELETE", key, {
			query: { uploadId },
			expect: [204, 200, 404],
		});
	}

	async list(prefix: string) {
		const keys: { key: string; size: number }[] = [];
		let token: string | undefined;
		do {
			const query: Record<string, string> = { "list-type": "2", prefix };
			if (token) query["continuation-token"] = token;
			const response = await this.send("GET", "", { query });
			const text = await response.text();
			for (const match of text.matchAll(
				/<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>/g,
			)) {
				keys.push({ key: decodeXml(match[1] ?? ""), size: Number(match[2]) });
			}
			token = text.match(
				/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/,
			)?.[1];
		} while (token);
		return keys;
	}

	async delete(key: string) {
		await this.send("DELETE", key, { expect: [204, 200, 404] });
	}
}

function decodeXml(value: string) {
	return value
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'");
}
