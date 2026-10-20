import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";

const mysqlImage =
	"mysql@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b";
const root = resolve(import.meta.dir, "..");
const tag = randomUUID().replaceAll("-", "").slice(0, 12);
const network = `cap-ownership-test-${tag}`;
const mysql = `cap-ownership-mysql-${tag}`;
const password = `synthetic_${randomBytes(20).toString("hex")}`;
const rootPassword = `synthetic_${randomBytes(20).toString("hex")}`;
const clean = { PATH: process.env.PATH ?? "", NO_COLOR: "1" };
const created: Array<"network" | "mysql" | "image"> = [];
let child: ReturnType<typeof Bun.spawn> | undefined;
const signals: NodeJS.EventEmitter = process;
let interrupted = false;
const stop = () => {
	interrupted = true;
	child?.kill("SIGTERM");
};
signals.once("SIGINT", stop);
signals.once("SIGTERM", stop);

async function docker(args: string[], extra: Record<string, string> = {}) {
	const proc = Bun.spawn(
		["docker", "--host", "unix:///var/run/docker.sock", ...args],
		{ env: { ...clean, ...extra }, stdout: "pipe", stderr: "pipe" },
	);
	const [code, output, error] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (code !== 0)
		throw new Error(
			`Synthetic container action failed (${args[0]}): ${error.trim()}`,
		);
	return output.trim();
}

try {
	if (process.argv.length !== 2 || process.platform !== "linux")
		throw new Error(
			"Run this synthetic integration harness on Linux without arguments",
		);
	let present = true;
	try {
		await docker(["image", "inspect", mysqlImage, "--format", "{{.Size}}"]);
	} catch (error) {
		if (!(error instanceof Error) || !error.message.includes("No such image"))
			throw error;
		present = false;
	}
	if (!present) {
		await docker(["pull", mysqlImage]);
		created.push("image");
	}
	const bytes = Number(
		await docker(["image", "inspect", mysqlImage, "--format", "{{.Size}}"]),
	);
	console.info(
		`Synthetic MySQL image footprint: ${Math.ceil(bytes / 1024 ** 2)} MiB`,
	);
	if (interrupted) throw new Error("Synthetic qualification interrupted");
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
			mysql,
			"--label",
			`cap.synthetic.ownership=${tag}`,
			"--network",
			network,
			"--publish",
			"127.0.0.1:0:3306",
			"--memory",
			"1g",
			"--cpus",
			"2",
			"--pids-limit",
			"256",
			"--tmpfs",
			"/var/lib/mysql:rw,size=768m",
			"--tmpfs",
			"/tmp:rw,size=64m",
			"-e",
			"MYSQL_DATABASE",
			"-e",
			"MYSQL_USER",
			"-e",
			"MYSQL_PASSWORD",
			"-e",
			"MYSQL_ROOT_PASSWORD",
			mysqlImage,
			"--skip-log-bin",
		],
		{
			MYSQL_DATABASE: "ownership_synthetic",
			MYSQL_USER: "synthetic",
			MYSQL_PASSWORD: password,
			MYSQL_ROOT_PASSWORD: rootPassword,
		},
	);
	created.push("mysql");
	const binding = await docker(["port", mysql, "3306/tcp"]);
	if (!/^127\.0\.0\.1:\d+$/.test(binding))
		throw new Error("Refusing non-loopback database binding");
	if (interrupted) throw new Error("Synthetic qualification interrupted");
	child = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			"run",
			"--cwd",
			"apps/web",
			"test",
			"__tests__/integration/recording-ownership-live.test.ts",
		],
		{
			cwd: root,
			env: {
				...clean,
				CAP_OWNERSHIP_INTEGRATION: "synthetic",
				CAP_OWNERSHIP_TEST_DATABASE: `mysql://synthetic:${password}@${binding}/ownership_synthetic`,
			},
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	process.exitCode = await child.exited;
} catch (error) {
	console.error(
		error instanceof Error ? error.message : "Synthetic qualification failed",
	);
	process.exitCode = 1;
} finally {
	for (const resource of created.reverse()) {
		try {
			if (resource === "mysql") await docker(["rm", "--force", mysql]);
			if (resource === "network") await docker(["network", "rm", network]);
			if (resource === "image") await docker(["image", "rm", mysqlImage]);
		} catch {
			console.error(`Synthetic ${resource} cleanup incomplete`);
			process.exitCode = 1;
		}
	}
	signals.removeListener("SIGINT", stop);
	signals.removeListener("SIGTERM", stop);
}
