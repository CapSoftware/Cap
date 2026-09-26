import { randomBytes } from "node:crypto";
import {
	copyFile,
	link,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	CAP_BUNDLE_CONTENT_TYPE,
	CAP_BUNDLE_HEADER_BYTES,
	CAP_BUNDLE_MAGIC,
	type CapBundleEntry,
	MAX_CAP_BUNDLE_BYTES,
	MAX_CAP_BUNDLE_FILES,
	MAX_CAP_BUNDLE_MANIFEST_BYTES,
	parseCapBundleManifest,
	validCapBundlePath,
} from "@cap/editor-cap-bundle";
import { publicEditorOrigin } from "./editor-socket-tickets";

type SnapshotFile = CapBundleEntry & {
	dev: number;
	ino: number;
	mtimeMs: number;
};

type BundleTicket = {
	sessionId: string;
	root: string;
	files: SnapshotFile[];
	manifestBytes: Uint8Array;
	fileName: string;
	size: number;
	expiresAt: number;
};

const tickets = new Map<string, BundleTicket>();
const encoder = new TextEncoder();
const TICKET_TTL_MS = 60_000;
const MAX_TICKETS = 100;
const READ_CHUNK_BYTES = 1024 * 1024;

function sameFile(
	left: {
		dev: number | bigint;
		ino: number | bigint;
		size: number | bigint;
		mtimeMs: number | bigint;
	},
	right: typeof left,
) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs
	);
}

export async function scanEditorProject(projectPath: string) {
	const project = await lstat(projectPath);
	if (!project.isDirectory()) throw new Error("Invalid editor project folder");
	const files: {
		path: string;
		source: string;
		stats: Awaited<ReturnType<typeof lstat>>;
	}[] = [];
	const pending = [{ directory: projectPath, prefix: "" }];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		for (const entry of await readdir(current.directory, {
			withFileTypes: true,
		})) {
			const path = current.prefix
				? `${current.prefix}/${entry.name}`
				: entry.name;
			const source = join(current.directory, entry.name);
			const stats = await lstat(source);
			if (stats.isDirectory()) {
				pending.push({ directory: source, prefix: path });
				continue;
			}
			if (!stats.isFile())
				throw new Error("Editor project contains an unsupported file");
			if (!validCapBundlePath(path)) {
				if (
					path.startsWith("content/") ||
					path.startsWith("output/") ||
					path.startsWith("screenshots/") ||
					path.startsWith("assets/audio/")
				)
					throw new Error("Editor project contains an invalid media path");
				continue;
			}
			files.push({ path, source, stats });
			if (files.length > MAX_CAP_BUNDLE_FILES)
				throw new Error("Editor project has too many files");
		}
	}
	files.sort((left, right) => left.path.localeCompare(right.path));
	if (!files.some((file) => file.path === "recording-meta.json"))
		throw new Error("Editor project is missing recording metadata");
	return files;
}

function bundleFileName(requestedName?: string) {
	const stem = requestedName?.endsWith(".capbundle")
		? requestedName.slice(0, -".capbundle".length)
		: null;
	return stem &&
		stem.length <= 180 &&
		!stem.includes("/") &&
		!stem.includes("\\") &&
		[...stem].every((character) => {
			const code = character.charCodeAt(0);
			return code > 31 && code !== 127;
		})
		? `${stem}.capbundle`
		: "Cap Recording.capbundle";
}

export async function createEditorProjectBundleDownloadTicket(
	sessionId: string,
	projectPath: string,
	requestedName?: string,
) {
	if (tickets.size >= MAX_TICKETS)
		throw new Error("Editor bundle download capacity is busy");
	const origin = publicEditorOrigin();
	const sources = await scanEditorProject(projectPath);
	const root = await mkdtemp(join(tmpdir(), "cap-web-editor-bundle-"));
	try {
		const files: SnapshotFile[] = [];
		let offset = 0;
		for (const source of sources) {
			const destination = join(root, source.path);
			await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
			if (
				source.path === "recording-meta.json" ||
				source.path === "project-config.json" ||
				source.path === "recording-diagnostics.json"
			) {
				await copyFile(source.source, destination);
			} else {
				await link(source.source, destination);
			}
			const [snapshot, current] = await Promise.all([
				lstat(destination),
				lstat(source.source),
			]);
			if (
				!snapshot.isFile() ||
				!current.isFile() ||
				!sameFile(current, source.stats) ||
				snapshot.size !== source.stats.size ||
				(snapshot.ino !== source.stats.ino &&
					source.path !== "recording-meta.json" &&
					source.path !== "project-config.json" &&
					source.path !== "recording-diagnostics.json")
			) {
				throw new Error("Editor project changed during bundle snapshot");
			}
			files.push({
				path: source.path,
				size: snapshot.size,
				offset,
				dev: snapshot.dev,
				ino: snapshot.ino,
				mtimeMs: snapshot.mtimeMs,
			});
			offset += snapshot.size;
			if (!Number.isSafeInteger(offset) || offset > MAX_CAP_BUNDLE_BYTES)
				throw new Error("Editor project bundle is too large");
		}
		const manifestBytes = encoder.encode(
			JSON.stringify({
				version: 1,
				files: files.map(({ path, size, offset }) => ({ path, size, offset })),
			}),
		);
		const size = CAP_BUNDLE_HEADER_BYTES + manifestBytes.byteLength + offset;
		if (
			manifestBytes.byteLength > MAX_CAP_BUNDLE_MANIFEST_BYTES ||
			size > MAX_CAP_BUNDLE_BYTES ||
			!parseCapBundleManifest(manifestBytes, size)
		) {
			throw new Error("Editor project bundle manifest is invalid");
		}
		const token = randomBytes(32).toString("base64url");
		tickets.set(token, {
			sessionId,
			root,
			files,
			manifestBytes,
			fileName: bundleFileName(requestedName),
			size,
			expiresAt: Date.now() + TICKET_TTL_MS,
		});
		return {
			url: `${origin}/editor/sessions/${encodeURIComponent(sessionId)}/project-bundle/download?ticket=${token}`,
		};
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

export function consumeEditorProjectBundleDownloadTicket(
	sessionId: string,
	token: string | null,
) {
	if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
	const ticket = tickets.get(token);
	tickets.delete(token);
	if (
		!ticket ||
		ticket.sessionId !== sessionId ||
		ticket.expiresAt < Date.now()
	) {
		if (ticket)
			void rm(ticket.root, { recursive: true, force: true }).catch(
				console.error,
			);
		return null;
	}
	return ticket;
}

async function* bundleChunks(ticket: BundleTicket) {
	try {
		const header = new Uint8Array(CAP_BUNDLE_HEADER_BYTES);
		header.set(encoder.encode(CAP_BUNDLE_MAGIC));
		new DataView(header.buffer).setUint32(
			CAP_BUNDLE_MAGIC.length,
			ticket.manifestBytes.byteLength,
			true,
		);
		yield header;
		yield ticket.manifestBytes;
		for (const file of ticket.files) {
			const handle = await open(join(ticket.root, file.path), "r");
			try {
				const before = await handle.stat();
				if (!sameFile(before, file))
					throw new Error("Editor project bundle file changed");
				let position = 0;
				while (position < file.size) {
					const bytes = Buffer.allocUnsafe(
						Math.min(READ_CHUNK_BYTES, file.size - position),
					);
					const result = await handle.read(
						bytes,
						0,
						bytes.byteLength,
						position,
					);
					if (result.bytesRead === 0)
						throw new Error("Editor project bundle file ended early");
					position += result.bytesRead;
					yield bytes.subarray(0, result.bytesRead);
				}
				if (!sameFile(await handle.stat(), before))
					throw new Error("Editor project bundle file changed");
			} finally {
				await handle.close();
			}
		}
	} finally {
		await rm(ticket.root, { recursive: true, force: true });
	}
}

export function editorProjectBundleResponse(ticket: BundleTicket) {
	const iterator = bundleChunks(ticket);
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await iterator.next();
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			} catch (error) {
				controller.error(error);
			}
		},
		async cancel() {
			await iterator.return(undefined);
			await rm(ticket.root, { recursive: true, force: true });
		},
	});
	const asciiName = ticket.fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
	const encodedName = encodeURIComponent(ticket.fileName).replace(
		/['()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return new Response(stream, {
		headers: {
			"Content-Type": CAP_BUNDLE_CONTENT_TYPE,
			"Content-Length": String(ticket.size),
			"Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
			"Cache-Control": "private, no-store",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

const ticketSweep = setInterval(() => {
	for (const [token, ticket] of tickets) {
		if (ticket.expiresAt < Date.now()) {
			tickets.delete(token);
			void rm(ticket.root, { recursive: true, force: true }).catch(
				console.error,
			);
		}
	}
}, 30_000);
ticketSweep.unref();
