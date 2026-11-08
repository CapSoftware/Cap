import { spawn as nodeSpawn } from "node:child_process";
import { basename } from "node:path";
import { spawn as bunSpawn } from "bun";
import {
	getSafeDemuxerWhitelist,
	isTrustedLocalPlaylist,
} from "./media-input-policy";

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

type BunSpawnOptions = {
	cmd?: string[];
	env?: Record<string, string | undefined>;
};

const rawBunSpawn = bunSpawn as unknown as (
	first: unknown,
	second?: unknown,
) => ReturnType<typeof bunSpawn>;

export const spawn = ((first: unknown, second?: unknown) => {
	if (Array.isArray(first)) {
		const options = (second ?? {}) as BunSpawnOptions;
		return rawBunSpawn(hardenMediaCommand(first), {
			...options,
			env: childProcessEnv(options.env),
		});
	}
	const options = first as BunSpawnOptions & { cmd: string[] };
	return rawBunSpawn({
		...options,
		cmd: hardenMediaCommand(options.cmd),
		env: childProcessEnv(options.env),
	});
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
	const [hardenedCommand, ...hardenedArgs] = hardenMediaCommand([
		command,
		...(args as string[]),
	]);
	const opts = (options ?? {}) as NodeSpawnOptions;
	return nodeSpawn(hardenedCommand as string, hardenedArgs, {
		...opts,
		env: childProcessEnv(opts.env),
	});
}) as unknown as typeof nodeSpawn;
