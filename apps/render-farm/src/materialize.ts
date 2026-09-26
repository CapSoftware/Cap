import {
	closeSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { S3 } from "./s3";

// Recreates a recording on local disk with only the bytes a task needs.
// Media files are created at full size as sparse files, and just the
// requested byte ranges (the moov, plus the samples around the task's time
// span) are written in. ffmpeg then opens them like the real recording, with
// correct timestamps and seeking, so the renderer needs no changes at all.

export type FileSpec = {
	/** Path inside the project directory. */
	path: string;
	key: string;
	size: number;
	/** Byte ranges [start, end) to fetch, or "all". */
	ranges: [number, number][] | "all";
};

const PIECE = 4 << 20;

type LocalFile = {
	fd: number;
	pieces: Map<number, Promise<void>>;
};

class Limiter {
	private active = 0;
	private queue: (() => void)[] = [];
	constructor(private limit: number) {}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.limit) {
			await new Promise<void>((resolve) => this.queue.push(resolve));
		}
		this.active++;
		try {
			return await fn();
		} finally {
			this.active--;
			this.queue.shift()?.();
		}
	}
}

export type FetchStats = { bytes: number; requests: number; ms: number };

export class ProjectCache {
	private files = new Map<string, LocalFile>();
	private rewritten = false;
	private limiter: Limiter;
	bytesFetched = 0;

	constructor(
		readonly s3: S3,
		readonly root: string,
		concurrency = Number(process.env.RF_FETCH_CONCURRENCY ?? 12),
	) {
		this.limiter = new Limiter(concurrency);
	}

	private open(spec: FileSpec) {
		const fullPath = resolve(this.root, spec.path);
		if (!fullPath.startsWith(resolve(this.root) + sep)) {
			throw new Error(`${spec.path} is outside the project`);
		}
		let file = this.files.get(fullPath);
		if (!file) {
			mkdirSync(dirname(fullPath), { recursive: true });
			const fd = openSync(fullPath, "w+");
			ftruncateSync(fd, spec.size);
			file = { fd, pieces: new Map() };
			this.files.set(fullPath, file);
		}
		return file;
	}

	private fetchPiece(
		spec: FileSpec,
		file: LocalFile,
		piece: number,
		stats: FetchStats,
	) {
		let pending = file.pieces.get(piece);
		if (!pending) {
			const start = piece * PIECE;
			const end = Math.min(spec.size, start + PIECE);
			pending = this.limiter.run(async () => {
				const bytes = await this.s3.getRange(spec.key, start, end - 1);
				if (bytes.byteLength !== end - start) {
					throw new Error(
						`short read ${spec.key} ${start}-${end}: ${bytes.byteLength}`,
					);
				}
				let written = 0;
				while (written < bytes.byteLength) {
					written += writeSync(
						file.fd,
						bytes,
						written,
						bytes.byteLength - written,
						start + written,
					);
				}
				this.bytesFetched += bytes.byteLength;
				stats.bytes += bytes.byteLength;
				stats.requests++;
			});
			pending.catch(() => file.pieces.delete(piece));
			file.pieces.set(piece, pending);
		}
		return pending;
	}

	async materialize(specs: FileSpec[]): Promise<FetchStats> {
		const started = performance.now();
		const stats: FetchStats = { bytes: 0, requests: 0, ms: 0 };
		const work: Promise<void>[] = [];
		for (const spec of specs) {
			if (spec.size === 0) {
				this.open(spec);
				continue;
			}
			const file = this.open(spec);
			const ranges: [number, number][] =
				spec.ranges === "all" ? [[0, spec.size]] : spec.ranges;
			const pieces = new Set<number>();
			for (const [start, end] of ranges) {
				const clampedEnd = Math.min(end, spec.size);
				if (clampedEnd <= start) continue;
				for (
					let piece = Math.floor(start / PIECE);
					piece <= Math.floor((clampedEnd - 1) / PIECE);
					piece++
				) {
					pieces.add(piece);
				}
			}
			for (const piece of pieces)
				work.push(this.fetchPiece(spec, file, piece, stats));
		}
		await Promise.all(work);
		if (
			!this.rewritten &&
			specs.some((spec) => spec.path === "project-config.json")
		) {
			// Configs reference bundled assets (wallpapers) relative to the
			// project; the renderer wants absolute paths.
			const path = join(this.root, "project-config.json");
			const text = readFileSync(path, "utf8");
			writeFileSync(path, text.replaceAll("$RF_PROJECT", this.root));
			this.rewritten = true;
		}
		stats.ms = Math.round(performance.now() - started);
		return stats;
	}

	close() {
		for (const file of this.files.values()) {
			try {
				closeSync(file.fd);
			} catch {}
		}
		this.files.clear();
	}
}
