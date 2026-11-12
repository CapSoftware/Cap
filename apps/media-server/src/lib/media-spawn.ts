import { spawn as nodeSpawn } from "node:child_process";
import { basename } from "node:path";
import { spawn as bunSpawn } from "bun";
import {
	getSafeDemuxerWhitelist,
	isTrustedLocalPlaylist,
	MAX_DECODE_PIXELS,
} from "./media-input-policy";
import { canRelayMediaInput, relayMediaInput } from "./media-relay";

const SENSITIVE_ENV_KEY =
	/SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API_?KEY|ACCESS_?KEY|AUTH|DATABASE_URL|_DSN$|^AWS_/i;

export function childProcessEnv(
	env: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined || SENSITIVE_ENV_KEY.test(key)) continue;
		result[key] = value;
	}
	return result;
}

function inputProtocols(input: string): string {
	if (/^https?:\/\//i.test(input)) return "http,https,tcp,tls";
	if (input === "-" || input.startsWith("pipe:")) return "pipe";
	return "file";
}

function hardenFfmpegArgs(cmd: readonly string[]): string[] {
	const out: string[] = [cmd[0] as string];
	let group: string[] = [];
	for (let i = 1; i < cmd.length; i++) {
		const arg = cmd[i] as string;
		if (arg !== "-i" || i + 1 >= cmd.length) {
			group.push(arg);
			continue;
		}
		const input = cmd[i + 1] as string;
		const forcedFormat = group.indexOf("-f");
		const forced = forcedFormat === -1 ? undefined : group[forcedFormat + 1];
		if (forced !== "lavfi") {
			if (!group.includes("-protocol_whitelist"))
				group.push("-protocol_whitelist", inputProtocols(input));
			if (
				forced === undefined &&
				!group.includes("-format_whitelist") &&
				!isTrustedLocalPlaylist(input)
			)
				group.push("-format_whitelist", getSafeDemuxerWhitelist());
		}
		out.push(...group, "-i", input);
		group = [];
		i++;
	}
	out.push(...group);
	return out;
}

function hardenFfprobeArgs(cmd: readonly string[]): string[] {
	const args = cmd.slice(1);
	const extra: string[] = [];
	if (!args.includes("-protocol_whitelist")) {
		const protocols = new Set<string>();
		for (const arg of args) {
			if (/^https?:\/\//i.test(arg))
				for (const p of ["http", "https", "tcp", "tls"]) protocols.add(p);
			else if (arg === "-" || arg.startsWith("pipe:")) protocols.add("pipe");
		}
		if (protocols.size === 0) protocols.add("file");
		extra.push("-protocol_whitelist", [...protocols].join(","));
	}
	if (
		!args.includes("-f") &&
		!args.includes("-format_whitelist") &&
		!args.some(isTrustedLocalPlaylist)
	)
		extra.push("-format_whitelist", getSafeDemuxerWhitelist());
	return [cmd[0] as string, ...extra, ...args];
}

// Untrusted media must not make FFmpeg open other files or network resources.
export function hardenMediaCommand(cmd: readonly string[]): string[] {
	const tool = basename(cmd[0] ?? "");
	if (tool === "ffmpeg") return hardenFfmpegArgs(cmd);
	if (tool === "ffprobe") return hardenFfprobeArgs(cmd);
	return [...cmd];
}

const FRAME_SIZE_LIMIT = ["-max_pixels", String(MAX_DECODE_PIXELS)];

// Applied to what is spawned rather than in hardenMediaCommand, so a decoder
// refuses an oversized frame even when the probe was told a smaller size.
export function limitDecodedFrameSize(cmd: readonly string[]): string[] {
	const tool = basename(cmd[0] ?? "");
	if (cmd.includes("-max_pixels")) return [...cmd];
	if (tool === "ffprobe")
		return [cmd[0] as string, ...FRAME_SIZE_LIMIT, ...cmd.slice(1)];
	if (tool !== "ffmpeg") return [...cmd];
	const out: string[] = [cmd[0] as string];
	let group: string[] = [];
	for (let i = 1; i < cmd.length; i++) {
		const arg = cmd[i] as string;
		if (arg !== "-i" || i + 1 >= cmd.length) {
			group.push(arg);
			continue;
		}
		const forcedFormat = group.indexOf("-f");
		if (forcedFormat === -1 || group[forcedFormat + 1] !== "lavfi")
			group.push(...FRAME_SIZE_LIMIT);
		out.push(...group, "-i", cmd[i + 1] as string);
		group = [];
		i++;
	}
	out.push(...group);
	return out;
}

// Points every remote input of an FFmpeg or ffprobe command at the relay.
// The returned release must be called once the process has gone.
export function relayRemoteInputs(cmd: readonly string[]): {
	cmd: string[];
	release: () => void;
} {
	const tool = basename(cmd[0] ?? "");
	const releases: (() => void)[] = [];
	const out = [...cmd];
	if (tool === "ffmpeg" || tool === "ffprobe") {
		for (let i = 1; i < out.length; i++) {
			const isInput =
				out[i - 1] === "-i" || (tool === "ffprobe" && i === out.length - 1);
			if (!isInput || !canRelayMediaInput(out[i] as string)) continue;
			const relayed = relayMediaInput(out[i] as string);
			out[i] = relayed.url;
			releases.push(relayed.release);
		}
	}
	return {
		cmd: out,
		release: () => {
			for (const release of releases.splice(0)) release();
		},
	};
}

function prepareMediaCommand(cmd: readonly string[]) {
	const relayed = relayRemoteInputs(hardenMediaCommand(cmd));
	return { cmd: limitDecodedFrameSize(relayed.cmd), release: relayed.release };
}

type BunSpawnOptions = {
	cmd?: string[];
	env?: Record<string, string | undefined>;
};

const rawBunSpawn = bunSpawn as unknown as (
	first: unknown,
	second?: unknown,
) => ReturnType<typeof bunSpawn>;

export const spawn = ((first: unknown, second?: unknown) => {
	const options = (Array.isArray(first) ? (second ?? {}) : first) as
		| BunSpawnOptions
		| (BunSpawnOptions & { cmd: string[] });
	const prepared = prepareMediaCommand(
		Array.isArray(first) ? first : (options.cmd as string[]),
	);
	try {
		const proc = rawBunSpawn({
			...options,
			cmd: prepared.cmd,
			env: childProcessEnv(options.env),
		});
		void proc.exited.finally(prepared.release);
		return proc;
	} catch (error) {
		prepared.release();
		throw error;
	}
}) as unknown as typeof bunSpawn;

type NodeSpawnOptions = { env?: Record<string, string | undefined> };

export const spawnNode = ((
	command: string,
	args?: unknown,
	options?: unknown,
) => {
	if (!Array.isArray(args)) {
		const opts = (args ?? {}) as NodeSpawnOptions;
		return nodeSpawn(command, { ...opts, env: childProcessEnv(opts.env) });
	}
	const prepared = prepareMediaCommand([command, ...(args as string[])]);
	const [hardenedCommand, ...hardenedArgs] = prepared.cmd;
	const opts = (options ?? {}) as NodeSpawnOptions;
	const child = nodeSpawn(hardenedCommand as string, hardenedArgs, {
		...opts,
		env: childProcessEnv(opts.env),
	});
	child.once("close", prepared.release);
	child.once("error", prepared.release);
	return child;
}) as unknown as typeof nodeSpawn;
