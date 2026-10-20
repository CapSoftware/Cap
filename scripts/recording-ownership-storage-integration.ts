import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const tag = randomUUID().replaceAll("-", "").slice(0, 12);
const network = `cap-ownership-storage-${tag}`;
const container = `cap-ownership-minio-${tag}`;
const image = `cap-ownership-minio-test:${tag}`;
const accessKey = `synthetic_${randomBytes(20).toString("hex")}`;
const secretKey = `synthetic_${randomBytes(20).toString("hex")}`;
const clean = { PATH: process.env.PATH ?? "", NO_COLOR: "1" };
const created: Array<"network" | "container" | "image"> = [];
let scratch: string | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;
const signals: NodeJS.EventEmitter = process;
let interrupted = false;
const stop = () => {
	interrupted = true;
	child?.kill("SIGTERM");
};
signals.once("SIGINT", stop);
signals.once("SIGTERM", stop);

async function command(args: string[], extra: Record<string, string> = {}) {
	const proc = Bun.spawn(args, {
		env: { ...clean, ...extra },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, output, error] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (code !== 0)
		throw new Error(
			`Synthetic storage action failed (${args[0]}): ${error.trim()}`,
		);
	return output.trim();
}
function docker(args: string[], extra?: Record<string, string>) {
	return command(
		["docker", "--host", "unix:///var/run/docker.sock", ...args],
		extra,
	);
}

try {
	const [binary, expectedHash] = process.argv.slice(2);
	if (
		process.platform !== "linux" ||
		process.argv.length !== 4 ||
		!binary ||
		!expectedHash ||
		!/^[a-f0-9]{64}$/.test(expectedHash)
	)
		throw new Error(
			"Provide the reviewed official-source static MinIO binary path and its SHA-256 on Linux",
		);
	const source = resolve(binary);
	const info = await stat(source);
	if (!info.isFile() || info.size > 512 * 1024 ** 2)
		throw new Error("Invalid synthetic storage binary");
	scratch = await mkdtemp(join(tmpdir(), "ownership-storage-synthetic-"));
	const copied = join(scratch, "minio");
	await copyFile(source, copied);
	if (
		createHash("sha256")
			.update(await readFile(copied))
			.digest("hex") !== expectedHash
	)
		throw new Error("Synthetic storage binary checksum mismatch");
	const archive = join(scratch, "rootfs.tar");
	await command(["tar", "-cf", archive, "-C", scratch, "minio"]);
	if (interrupted)
		throw new Error("Synthetic storage qualification interrupted");
	await docker([
		"image",
		"import",
		"--change",
		'ENTRYPOINT ["/minio"]',
		"--change",
		"USER 65532:65532",
		"--change",
		`LABEL cap.synthetic.ownership=${tag}`,
		archive,
		image,
	]);
	created.push("image");
	await docker([
		"network",
		"create",
		"--label",
		`cap.synthetic.ownership=${tag}`,
		network,
	]);
	created.push("network");
	await docker(
		[
			"run",
			"--detach",
			"--rm",
			"--pull",
			"never",
			"--name",
			container,
			"--label",
			`cap.synthetic.ownership=${tag}`,
			"--network",
			network,
			"--publish",
			"127.0.0.1:0:9000",
			"--read-only",
			"--memory",
			"1g",
			"--cpus",
			"2",
			"--pids-limit",
			"256",
			"--tmpfs",
			"/data:rw,size=768m,uid=65532,gid=65532,mode=0700",
			"--tmpfs",
			"/tmp:rw,size=64m,uid=65532,gid=65532,mode=0700",
			"-e",
			"MINIO_ROOT_USER",
			"-e",
			"MINIO_ROOT_PASSWORD",
			"-e",
			"MINIO_BROWSER=off",
			"-e",
			"MINIO_UPDATE=off",
			"-e",
			"GOMAXPROCS=2",
			"-e",
			"GOMEMLIMIT=384MiB",
			image,
			"--certs-dir",
			"/tmp/certs",
			"server",
			"/data",
			"--address",
			":9000",
			"--console-address",
			"127.0.0.1:9001",
			"--quiet",
		],
		{ MINIO_ROOT_USER: accessKey, MINIO_ROOT_PASSWORD: secretKey },
	);
	created.push("container");
	const binding = await docker(["port", container, "9000/tcp"]);
	if (!/^127\.0\.0\.1:\d+$/.test(binding))
		throw new Error("Refusing non-loopback storage binding");
	if (interrupted)
		throw new Error("Synthetic storage qualification interrupted");
	console.info(
		`Synthetic source-built MinIO binary footprint: ${Math.ceil(info.size / 1024 ** 2)} MiB`,
	);
	child = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			"run",
			"--cwd",
			"apps/web",
			"test",
			"__tests__/integration/recording-ownership-storage-live.test.ts",
		],
		{
			cwd: root,
			env: {
				...clean,
				CAP_OWNERSHIP_STORAGE_INTEGRATION: "synthetic",
				CAP_OWNERSHIP_TEST_S3_ENDPOINT: `http://${binding}`,
				CAP_OWNERSHIP_TEST_S3_ACCESS_KEY: accessKey,
				CAP_OWNERSHIP_TEST_S3_SECRET_KEY: secretKey,
				CAP_OWNERSHIP_TEST_S3_BUCKET_PREFIX: `ownership-synthetic-${tag}`,
			},
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	process.exitCode = await child.exited;
} catch (error) {
	console.error(
		error instanceof Error
			? error.message
			: "Synthetic storage qualification failed",
	);
	process.exitCode = 1;
} finally {
	for (const resource of created.reverse()) {
		try {
			if (resource === "container") await docker(["rm", "--force", container]);
			if (resource === "network") await docker(["network", "rm", network]);
			if (resource === "image") await docker(["image", "rm", image]);
		} catch {
			console.error(`Synthetic storage ${resource} cleanup incomplete`);
			process.exitCode = 1;
		}
	}
	if (scratch) await rm(scratch, { recursive: true, force: true });
	signals.removeListener("SIGINT", stop);
	signals.removeListener("SIGTERM", stop);
}
