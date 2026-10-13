import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	runCommand,
	signUpdaterArtifact,
	withoutUpdaterSecrets,
} from "./finalize-linux-appimage.mjs";

export const webviewDebPackages = new Set([
	"libwebkit2gtk-4.1-0",
	"libgtk-3-0",
]);
export const webviewRpmRequirements = new Set([
	"libwebkit2gtk-4.1.so.0",
	"libgtk-3.so.0",
	"webkit2gtk4.1",
	"gtk3",
]);

// Level 22 keeps a 128 MiB window, the default limit of zstd decoders, so it
// still installs everywhere while matching across the bundled libraries.
export const RPM_PAYLOAD = "w22T0.zstdio";

// dpkg-deb only offers presets, whose largest dictionary is 64 MiB; 192 MiB
// lets xz match cap-cli against the Cap binary it shares most of its code with.
export const DEB_DATA_XZ = ["--threads=1", "--lzma2=preset=9,dict=192MiB"];

export function withoutWebviewDebDependencies(control) {
	const fields = [];
	for (const line of control.split("\n")) {
		if (/^[ \t]/.test(line) && fields.length > 0) fields.at(-1).push(line);
		else if (line) fields.push([line]);
	}
	const lines = fields.flatMap(([first, ...continuation]) => {
		const match = /^Depends:(.*)$/.exec(first);
		if (!match) return [first, ...continuation];
		const depends = [match[1], ...continuation]
			.join(" ")
			.split(",")
			.map((dependency) => dependency.trim())
			.filter(
				(dependency) =>
					dependency &&
					(dependency.includes("|") ||
						!webviewDebPackages.has(dependency.split(/[\s(]/, 1)[0])),
			);
		return depends.length > 0 ? [`Depends: ${depends.join(", ")}`] : [];
	});
	return `${lines.join("\n")}\n`;
}

export function withoutWebviewRpmRequirements(requirements) {
	return requirements.filter((requirement) => {
		const name = requirement.split(/\s/, 1)[0];
		return (
			name &&
			!name.startsWith("rpmlib(") &&
			!webviewRpmRequirements.has(name.replace(/\(\)\(64bit\)$/, ""))
		);
	});
}

export async function linkDuplicateLibraries(directory) {
	const entries = await readdir(directory, { withFileTypes: true }).catch(
		(error) => {
			if (error.code === "ENOENT") return [];
			throw error;
		},
	);
	const files = entries
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name);
	const linked = [];
	for (const name of files.filter((file) => file.endsWith(".so")).sort()) {
		const candidates = files
			.filter(
				(file) =>
					file.startsWith(`${name}.`) &&
					/^(?:\.\d+)+$/.test(file.slice(name.length)),
			)
			.sort((a, b) => a.length - b.length || a.localeCompare(b));
		for (const target of candidates) {
			const [source, versioned] = await Promise.all([
				readFile(path.join(directory, name)),
				readFile(path.join(directory, target)),
			]);
			if (!source.equals(versioned)) continue;
			await rm(path.join(directory, name));
			await symlink(target, path.join(directory, name));
			linked.push({ name, target, bytes: source.length });
			break;
		}
	}
	return linked;
}

export function withoutLinkedFiles(md5sums, removed) {
	const paths = new Set(removed);
	return md5sums
		.split("\n")
		.filter((line) => {
			const match = /^[0-9a-f]{32} {2}(.+)$/.exec(line);
			return !match || !paths.has(match[1]);
		})
		.join("\n");
}

export function withInstalledSize(control, freedBytes) {
	return control.replace(/^Installed-Size: (\d+)$/m, (_, size) => {
		const freed = Math.ceil(freedBytes / 1024);
		return `Installed-Size: ${Math.max(0, Number(size) - freed)}`;
	});
}

const escapeMacros = (value) => value.replaceAll("%", "%%");
const permissions = (mode) => (mode & 0o7777).toString(8).padStart(4, "0");

export function rpmFileEntry({ mode, user, group, name }) {
	if (!name.startsWith("/") || /["\n*?[\]{}\\]/.test(name)) {
		throw new Error(`Unsupported RPM file name: ${JSON.stringify(name)}`);
	}
	const target = `"${escapeMacros(name)}"`;
	const owner = `${user},${group}`;
	switch (mode & 0o170000) {
		case 0o040000:
			return `%dir %attr(${permissions(mode)},${owner}) ${target}`;
		case 0o100000:
			return `%attr(${permissions(mode)},${owner}) ${target}`;
		case 0o120000:
			return `%attr(-,${owner}) ${target}`;
		default:
			throw new Error(`Unsupported RPM file type for ${name}`);
	}
}

export function parseRpmFiles(listing) {
	return listing
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const match = /^(\d+) (\d+) (\S+) (\S+) (\/.*)$/.exec(line);
			if (!match) throw new Error(`Unrecognized RPM file entry: ${line}`);
			if (match[2] !== "0") {
				throw new Error(`Unsupported RPM file attributes for ${match[5]}`);
			}
			return {
				mode: Number(match[1]),
				user: match[3],
				group: match[4],
				name: match[5],
			};
		});
}

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function rpmSpec({
	name,
	version,
	release,
	summary,
	license,
	url,
	description,
	requires,
	files,
	staging,
}) {
	const summaryLine = escapeMacros(summary || name);
	return [
		`Name: ${name}`,
		`Version: ${version}`,
		`Release: ${release}`,
		`Summary: ${summaryLine}`,
		`License: ${escapeMacros(license)}`,
		...(url ? [`URL: ${escapeMacros(url)}`] : []),
		"AutoReqProv: no",
		...requires.map((requirement) => `Requires: ${requirement}`),
		"",
		"%description",
		description ? escapeMacros(description) : summaryLine,
		"",
		"%install",
		`cp -a ${escapeMacros(shellQuote(staging))}/. "%{buildroot}/"`,
		"",
		"%files",
		...files.map(rpmFileEntry),
		"",
	].join("\n");
}

function requireSigningKey(unsigned, env) {
	if (!unsigned && !env.TAURI_SIGNING_PRIVATE_KEY) {
		throw new Error(
			"TAURI_SIGNING_PRIVATE_KEY is required to sign the final Linux package",
		);
	}
}

async function replaceArtifact(output, destination, { unsigned, env, run }) {
	if (!unsigned) await signUpdaterArtifact(output, { env, run });
	await rename(output, destination);
	if (unsigned) await rm(`${destination}.sig`, { force: true });
	else await rename(`${output}.sig`, `${destination}.sig`);
}

const captured = (env) => ({
	env: { ...env, LC_ALL: "C" },
	encoding: "utf8",
	stdio: ["ignore", "pipe", "inherit"],
});

async function recompressDebData(uncompressed, output, members, { env, run }) {
	await mkdir(members);
	const names = (await run("ar", ["t", uncompressed], captured(env))).stdout
		.split("\n")
		.filter(Boolean);
	if (
		names.length !== 3 ||
		names[0] !== "debian-binary" ||
		!/^control\.tar(?:\.[a-z0-9]+)?$/.test(names[1]) ||
		names[2] !== "data.tar"
	) {
		throw new Error(`Unexpected deb members: ${names.join(", ")}`);
	}
	await run("ar", ["x", uncompressed], { cwd: members, env });
	await run("xz", [...DEB_DATA_XZ, "data.tar"], { cwd: members, env });
	await run("ar", ["rcD", output, names[0], names[1], "data.tar.xz"], {
		cwd: members,
		env,
	});
	const [expected, actual] = await Promise.all(
		[uncompressed, output].map(
			async (file) =>
				(await run("dpkg-deb", ["--contents", file], captured(env))).stdout,
		),
	);
	if (expected !== actual) {
		throw new Error("The recompressed deb does not contain the same files");
	}
}

export async function finalizeGpuiDeb(
	filename,
	{ unsigned = false, env = process.env, run = runCommand } = {},
) {
	const deb = path.resolve(filename);
	if (!deb.endsWith(".deb")) throw new Error("Expected a .deb artifact");
	requireSigningKey(unsigned, env);
	const tools = withoutUpdaterSecrets(env);
	const work = await mkdtemp(path.join(path.dirname(deb), ".cap-deb-"));
	try {
		const root = path.join(work, "root");
		await run("dpkg-deb", ["--raw-extract", deb, root], { env: tools });
		const linked = await linkDuplicateLibraries(
			path.join(root, "usr", "lib", "cap"),
		);
		const control = path.join(root, "DEBIAN", "control");
		await writeFile(
			control,
			withInstalledSize(
				withoutWebviewDebDependencies(await readFile(control, "utf8")),
				linked.reduce((total, link) => total + link.bytes, 0),
			),
		);
		const md5sums = path.join(root, "DEBIAN", "md5sums");
		if (linked.length > 0 && (await stat(md5sums).catch(() => null))) {
			await writeFile(
				md5sums,
				withoutLinkedFiles(
					await readFile(md5sums, "utf8"),
					linked.map((link) => `usr/lib/cap/${link.name}`),
				),
			);
		}
		const uncompressed = path.join(work, "uncompressed.deb");
		await run(
			"dpkg-deb",
			["--root-owner-group", "-Znone", "--build", root, uncompressed],
			{ env: tools },
		);
		const output = path.join(work, path.basename(deb));
		await recompressDebData(uncompressed, output, path.join(work, "members"), {
			env: tools,
			run,
		});
		await replaceArtifact(output, deb, { unsigned, env, run });
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

async function queryRpm(rpm, args, env, run) {
	const result = await run("rpm", ["--query", "--package", ...args, rpm], {
		env: { ...env, LC_ALL: "C" },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
	if (typeof result.stdout !== "string") {
		throw new Error(`Could not query ${rpm}`);
	}
	return result.stdout;
}

const queryTag = async (rpm, tag, env, run) => {
	const value = (
		await queryRpm(rpm, ["--queryformat", `%{${tag}}`], env, run)
	).trim();
	return value === "(none)" ? "" : value;
};

export async function finalizeGpuiRpm(
	filename,
	{ unsigned = false, env = process.env, run = runCommand } = {},
) {
	const rpm = path.resolve(filename);
	if (!rpm.endsWith(".rpm")) throw new Error("Expected an .rpm artifact");
	requireSigningKey(unsigned, env);
	const tools = withoutUpdaterSecrets(env);
	if ((await queryRpm(rpm, ["--scripts"], tools, run)).trim()) {
		throw new Error(`${rpm} has install scripts that cannot be carried over`);
	}
	const tags = {};
	for (const tag of [
		"NAME",
		"VERSION",
		"RELEASE",
		"ARCH",
		"SUMMARY",
		"LICENSE",
		"URL",
		"DESCRIPTION",
	]) {
		tags[tag] = await queryTag(rpm, tag, tools, run);
	}
	const requires = withoutWebviewRpmRequirements(
		(await queryRpm(rpm, ["--requires"], tools, run))
			.split("\n")
			.map((line) => line.trim()),
	);
	const files = parseRpmFiles(
		await queryRpm(
			rpm,
			[
				"--queryformat",
				"[%{FILEMODES} %{FILEFLAGS} %{FILEUSERNAME} %{FILEGROUPNAME} %{FILENAMES}\\n]",
			],
			tools,
			run,
		),
	);

	const work = await mkdtemp(path.join(path.dirname(rpm), ".cap-rpm-"));
	try {
		const staging = path.join(work, "staging");
		const top = path.join(work, "rpmbuild");
		const output = path.join(work, "output");
		await mkdir(staging);
		for (const directory of [
			"BUILD",
			"BUILDROOT",
			"RPMS",
			"SOURCES",
			"SPECS",
		]) {
			await mkdir(path.join(top, directory), { recursive: true });
		}
		await run("bsdtar", ["-xf", rpm, "-C", staging], { env: tools });
		const linked = new Set(
			(
				await linkDuplicateLibraries(path.join(staging, "usr", "lib", "cap"))
			).map((link) => `/usr/lib/cap/${link.name}`),
		);
		for (const file of files) {
			if (linked.has(file.name)) file.mode = 0o120777;
		}
		const spec = path.join(top, "SPECS", `${tags.NAME}.spec`);
		await writeFile(
			spec,
			rpmSpec({
				name: tags.NAME,
				version: tags.VERSION,
				release: tags.RELEASE,
				summary: tags.SUMMARY,
				license: tags.LICENSE,
				url: tags.URL,
				description: tags.DESCRIPTION,
				requires,
				files,
				staging,
			}),
		);
		await run(
			"rpmbuild",
			[
				"-bb",
				spec,
				"--target",
				tags.ARCH,
				"--define",
				`_topdir ${top}`,
				"--define",
				`_rpmdir ${output}`,
				"--define",
				`_rpmfilename ${escapeMacros(path.basename(rpm))}`,
				"--define",
				`_binary_payload ${RPM_PAYLOAD}`,
				"--define",
				"_build_id_links none",
				"--define",
				"debug_package %{nil}",
				"--define",
				"__arch_install_post %{nil}",
				"--define",
				"__os_install_post %{nil}",
			],
			{ env: { ...tools, LC_ALL: "C" } },
		);
		await replaceArtifact(path.join(output, path.basename(rpm)), rpm, {
			unsigned,
			env,
			run,
		});
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const args = process.argv.slice(2);
	const unsigned = args.includes("--unsigned");
	const files = args.filter((arg) => arg !== "--unsigned");
	if (process.platform !== "linux" || files.length === 0) {
		throw new Error(
			"Run on Linux: node scripts/finalize-linux-gpui-packages.mjs [--unsigned] <Cap.deb|Cap.rpm>...",
		);
	}
	for (const file of files) {
		if (file.endsWith(".deb")) await finalizeGpuiDeb(file, { unsigned });
		else await finalizeGpuiRpm(file, { unsigned });
		console.log(`Finalized ${file}`);
	}
}
