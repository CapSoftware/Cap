import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runCommand, signUpdaterArtifact } from "./finalize-linux-appimage.mjs";

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

const payloadCodecs = {
	gzip: "gzdio",
	bzip2: "bzdio",
	xz: "xzdio",
	lzma: "lzdio",
	zstd: "zstdio",
};

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

export async function finalizeGpuiDeb(
	filename,
	{ unsigned = false, env = process.env, run = runCommand } = {},
) {
	const deb = path.resolve(filename);
	if (!deb.endsWith(".deb")) throw new Error("Expected a .deb artifact");
	requireSigningKey(unsigned, env);
	const work = await mkdtemp(path.join(path.dirname(deb), ".cap-deb-"));
	try {
		const root = path.join(work, "root");
		await run("dpkg-deb", ["--raw-extract", deb, root], { env });
		const control = path.join(root, "DEBIAN", "control");
		await writeFile(
			control,
			withoutWebviewDebDependencies(await readFile(control, "utf8")),
		);
		const output = path.join(work, path.basename(deb));
		await run(
			"dpkg-deb",
			["--root-owner-group", "-Zxz", "--build", root, output],
			{ env },
		);
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
	if ((await queryRpm(rpm, ["--scripts"], env, run)).trim()) {
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
		"PAYLOADCOMPRESSOR",
		"PAYLOADFLAGS",
	]) {
		tags[tag] = await queryTag(rpm, tag, env, run);
	}
	const codec = payloadCodecs[tags.PAYLOADCOMPRESSOR];
	if (!codec) {
		throw new Error(
			`Unsupported RPM payload compressor: ${tags.PAYLOADCOMPRESSOR}`,
		);
	}
	const requires = withoutWebviewRpmRequirements(
		(await queryRpm(rpm, ["--requires"], env, run))
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
			env,
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
		await run("bsdtar", ["-xf", rpm, "-C", staging], { env });
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
				`_binary_payload w${tags.PAYLOADFLAGS || "9"}.${codec}`,
				"--define",
				"_build_id_links none",
				"--define",
				"debug_package %{nil}",
				"--define",
				"__arch_install_post %{nil}",
				"--define",
				"__os_install_post %{nil}",
			],
			{ env: { ...env, LC_ALL: "C" } },
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
