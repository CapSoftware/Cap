import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findOnPath(name) {
	const command = process.platform === "win32" ? "where.exe" : "which";
	const result = spawnSync(command, [name], { encoding: "utf8" });
	if (result.status !== 0) return null;
	return result.stdout.trim().split(/\r?\n/).find(Boolean) ?? null;
}

export function resolveLocalCargo() {
	if (process.env.CAP_USE_CINDER === "0") return "cargo";
	if (process.env.CARGO) return process.env.CARGO;
	if (process.platform !== "darwin") return "cargo";
	return findOnPath("cinder") ?? "cargo";
}

export function usesCinder(cargo = resolveLocalCargo()) {
	return path.basename(cargo, ".exe") === "cinder";
}

export function localCargoEnv(env = process.env) {
	return { ...env, CARGO: resolveLocalCargo() };
}

export function withTauriDevRunner(args, cargo = resolveLocalCargo()) {
	if (!usesCinder(cargo) || args.includes("--runner")) return args;
	const tauriDev = args.findIndex(
		(argument, index) => argument === "tauri" && args[index + 1] === "dev",
	);
	if (tauriDev === -1) return args;
	return [...args, "--runner", cargo];
}

const isMain =
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
	const cargo = resolveLocalCargo();
	const args = withTauriDevRunner(process.argv.slice(2), cargo);
	if (args.length === 0) {
		process.stdout.write(`${cargo}\n`);
		process.exit(0);
	}
	if (args[0] === "cargo") args[0] = cargo;
	const child = spawn(args[0], args.slice(1), {
		stdio: "inherit",
		env: { ...process.env, CARGO: cargo },
	});
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 1);
	});
}
