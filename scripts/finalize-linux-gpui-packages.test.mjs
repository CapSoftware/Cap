import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	finalizeGpuiDeb,
	finalizeGpuiRpm,
	linkDuplicateLibraries,
	parseRpmFiles,
	rpmFileEntry,
	rpmSpec,
	withInstalledSize,
	withoutLinkedFiles,
	withoutWebviewDebDependencies,
	withoutWebviewRpmRequirements,
} from "./finalize-linux-gpui-packages.mjs";

const available = (command) =>
	spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;

async function workspace(t) {
	const root = await mkdtemp(path.join(tmpdir(), "cap-linux-packages-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

const capture = (command, args) => {
	const result = spawnSync(command, args, { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
};

test("deb control keeps every dependency except the injected webview stack", () => {
	const control = [
		"Package: cap",
		"Version: 0.6.1",
		"Depends: libva2, libasound2t64 | libasound2, libwebkit2gtk-4.1-0,",
		" libgtk-3-0 (>= 3.24), libwebkit2gtk-4.1-0 | libwebkit2gtk-4.0-37, libx11-6",
		"Description: Cap",
		" Beautiful screen recordings.",
		"",
	].join("\n");
	assert.equal(
		withoutWebviewDebDependencies(control),
		[
			"Package: cap",
			"Version: 0.6.1",
			"Depends: libva2, libasound2t64 | libasound2, libwebkit2gtk-4.1-0 | libwebkit2gtk-4.0-37, libx11-6",
			"Description: Cap",
			" Beautiful screen recordings.",
			"",
		].join("\n"),
	);
	assert.equal(
		withoutWebviewDebDependencies(
			"Package: cap\nDepends: libgtk-3-0, libwebkit2gtk-4.1-0\n",
		),
		"Package: cap\n",
	);
});

test("rpm requirements drop rpmlib markers and the injected webview libraries", () => {
	assert.deepEqual(
		withoutWebviewRpmRequirements([
			"libva",
			"libwebkit2gtk-4.1.so.0()(64bit)",
			"libgtk-3.so.0()(64bit)",
			"libgtk-3.so.0",
			"webkit2gtk4.1",
			"openssl-libs >= 3.0",
			"rpmlib(CompressedFileNames) <= 3.0.4-1",
			"",
		]),
		["libva", "openssl-libs >= 3.0"],
	);
});

test("rpm file entries preserve type, permissions and ownership", () => {
	const files = parseRpmFiles(
		[
			"33261 0 root root /usr/bin/Cap",
			"33188 0 root root /usr/lib/Cap/assets/music/lofi 100%.mp3",
			"16877 0 root root /usr/lib/Cap",
			"41471 0 root root /usr/lib/cap/libonnxruntime.so",
			"",
		].join("\n"),
	);
	assert.deepEqual(files.map(rpmFileEntry), [
		'%attr(0755,root,root) "/usr/bin/Cap"',
		'%attr(0644,root,root) "/usr/lib/Cap/assets/music/lofi 100%%.mp3"',
		'%dir %attr(0755,root,root) "/usr/lib/Cap"',
		'%attr(-,root,root) "/usr/lib/cap/libonnxruntime.so"',
	]);
	assert.throws(
		() => parseRpmFiles("33188 1 root root /etc/cap.conf\n"),
		/Unsupported RPM file attributes/,
	);
	for (const name of ["/usr/lib/Cap/*.mp3", '/usr/lib/"quoted"', "relative"]) {
		assert.throws(
			() => rpmFileEntry({ mode: 0o100644, user: "root", group: "root", name }),
			/Unsupported RPM file name/,
		);
	}
	assert.throws(
		() =>
			rpmFileEntry({
				mode: 0o060644,
				user: "root",
				group: "root",
				name: "/dev/cap",
			}),
		/Unsupported RPM file type/,
	);
});

test("rpm spec disables automatic dependencies and escapes macros", () => {
	const spec = rpmSpec({
		name: "cap",
		version: "0.6.1",
		release: "1",
		summary: "100% yours",
		license: "AGPL-3.0",
		url: "",
		description: "",
		requires: ["libva"],
		files: [
			{ mode: 0o100755, user: "root", group: "root", name: "/usr/bin/Cap" },
		],
		staging: "/tmp/it's %{here}",
	});
	assert.match(spec, /^AutoReqProv: no$/m);
	assert.match(spec, /^Summary: 100%% yours$/m);
	assert.match(spec, /^Requires: libva$/m);
	assert.doesNotMatch(spec, /^URL:/m);
	assert.match(spec, /%description\n100%% yours\n/);
	assert.match(
		spec,
		/^cp -a '\/tmp\/it'\\''s %%\{here\}'\/\. "%\{buildroot\}\/"$/m,
	);
	assert.match(spec, /%files\n%attr\(0755,root,root\) "\/usr\/bin\/Cap"\n$/);
});

test("identical unversioned libraries become links to their versioned soname", async (t) => {
	const root = await workspace(t);
	const library = path.join(root, "lib");
	await mkdir(library);
	await writeFile(path.join(library, "libonnxruntime.so"), "onnx");
	await writeFile(path.join(library, "libonnxruntime.so.1"), "onnx");
	await writeFile(path.join(library, "libonnxruntime.so.1.20.1"), "onnx");
	await writeFile(path.join(library, "libheif.so"), "old heif");
	await writeFile(path.join(library, "libheif.so.1"), "new heif");
	await writeFile(path.join(library, "libavcodec.so.61"), "codec");
	await writeFile(path.join(library, "libnot.sox"), "other");
	await writeFile(path.join(library, "libnot.sox.1"), "other");

	assert.deepEqual(await linkDuplicateLibraries(library), [
		{ name: "libonnxruntime.so", target: "libonnxruntime.so.1", bytes: 4 },
	]);
	assert.equal(
		await readlink(path.join(library, "libonnxruntime.so")),
		"libonnxruntime.so.1",
	);
	assert.equal(
		await readFile(path.join(library, "libonnxruntime.so"), "utf8"),
		"onnx",
	);
	for (const file of ["libheif.so", "libavcodec.so.61", "libnot.sox"]) {
		assert.ok((await lstat(path.join(library, file))).isFile(), file);
	}
	assert.deepEqual(await linkDuplicateLibraries(library), []);
	assert.deepEqual(await linkDuplicateLibraries(path.join(root, "absent")), []);
});

test("deb metadata drops linked files from md5sums and Installed-Size", () => {
	assert.equal(
		withoutLinkedFiles(
			[
				"d41d8cd98f00b204e9800998ecf8427e  usr/bin/Cap",
				"0cc175b9c0f1b6a831c399e269772661  usr/lib/cap/libonnxruntime.so",
				"92eb5ffee6ae2fec3ad71c777531578f  usr/lib/cap/libonnxruntime.so.1",
				"",
			].join("\n"),
			["usr/lib/cap/libonnxruntime.so"],
		),
		[
			"d41d8cd98f00b204e9800998ecf8427e  usr/bin/Cap",
			"92eb5ffee6ae2fec3ad71c777531578f  usr/lib/cap/libonnxruntime.so.1",
			"",
		].join("\n"),
	);
	assert.equal(
		withInstalledSize(
			"Package: cap\nInstalled-Size: 286485\nArchitecture: amd64\n",
			22146944,
		),
		"Package: cap\nInstalled-Size: 264857\nArchitecture: amd64\n",
	);
	assert.equal(withInstalledSize("Package: cap\n", 1024), "Package: cap\n");
});

for (const [name, listing, expected] of [
	["signs the rebuilt package before replacing it", "same", null],
	[
		"refuses a recompressed package with different contents",
		"differs",
		/does not contain the same files/,
	],
]) {
	test(`deb finalization ${name}`, async (t) => {
		const root = await workspace(t);
		const deb = path.join(root, "Cap_0.6.1_amd64.deb");
		await writeFile(deb, "original");
		await writeFile(`${deb}.sig`, "original signature");
		const calls = [];
		const env = { TAURI_SIGNING_PRIVATE_KEY: "key" };
		const operation = finalizeGpuiDeb(deb, {
			env,
			run: async (command, args, options) => {
				calls.push(command === "ar" ? `ar ${args[0]}` : command);
				if (command === "dpkg-deb" && args[0] === "--raw-extract") {
					await mkdir(path.join(args[2], "DEBIAN"), { recursive: true });
					await writeFile(
						path.join(args[2], "DEBIAN/control"),
						"Package: cap\nDepends: libva2, libwebkit2gtk-4.1-0, libgtk-3-0\n",
					);
				} else if (command === "dpkg-deb" && args[0] === "--contents") {
					return {
						stdout:
							listing === "differs" && args[1].endsWith("uncompressed.deb")
								? "drwxr-xr-x root/root 0 ./usr/\n"
								: "drwxr-xr-x root/root 0 ./usr/bin/\n",
					};
				} else if (command === "dpkg-deb") {
					assert.deepEqual(args.slice(0, 3), [
						"--root-owner-group",
						"-Znone",
						"--build",
					]);
					assert.equal(
						await readFile(path.join(args[3], "DEBIAN/control"), "utf8"),
						"Package: cap\nDepends: libva2\n",
					);
					await writeFile(args[4], "uncompressed");
				} else if (command === "ar" && args[0] === "t") {
					return { stdout: "debian-binary\ncontrol.tar\ndata.tar\n" };
				} else if (command === "ar" && args[0] === "x") {
					for (const member of ["debian-binary", "control.tar", "data.tar"]) {
						await writeFile(path.join(options.cwd, member), member);
					}
				} else if (command === "xz") {
					assert.deepEqual(args, [
						"--threads=1",
						"--lzma2=preset=9,dict=192MiB",
						"data.tar",
					]);
					await rm(path.join(options.cwd, "data.tar"));
					await writeFile(path.join(options.cwd, "data.tar.xz"), "xz");
				} else if (command === "ar") {
					assert.deepEqual(args.slice(0, 1), ["rcD"]);
					assert.deepEqual(args.slice(2), [
						"debian-binary",
						"control.tar",
						"data.tar.xz",
					]);
					await writeFile(args[1], "rebuilt");
				} else {
					assert.deepEqual(args.slice(0, 4), [
						"run",
						"tauri",
						"signer",
						"sign",
					]);
					assert.equal(options.env.TAURI_PRIVATE_KEY, "key");
					assert.equal(await readFile(args[4], "utf8"), "rebuilt");
					await writeFile(`${args[4]}.sig`, "rebuilt signature");
				}
				return {};
			},
		});
		if (expected) {
			await assert.rejects(operation, expected);
			assert.equal(await readFile(deb, "utf8"), "original");
			assert.equal(await readFile(`${deb}.sig`, "utf8"), "original signature");
			return;
		}
		await operation;
		assert.deepEqual(calls, [
			"dpkg-deb",
			"dpkg-deb",
			"ar t",
			"ar x",
			"xz",
			"ar rcD",
			"dpkg-deb",
			"dpkg-deb",
			"bun",
		]);
		assert.equal(await readFile(deb, "utf8"), "rebuilt");
		assert.equal(await readFile(`${deb}.sig`, "utf8"), "rebuilt signature");
	});
}

test("package finalization requires a signing key unless unsigned", async (t) => {
	const root = await workspace(t);
	const deb = path.join(root, "Cap.deb");
	const rpm = path.join(root, "Cap.rpm");
	await writeFile(deb, "original");
	await writeFile(rpm, "original");
	const run = () => assert.fail("no command should run");
	await assert.rejects(
		finalizeGpuiDeb(deb, { env: {}, run }),
		/TAURI_SIGNING_PRIVATE_KEY/,
	);
	await assert.rejects(
		finalizeGpuiRpm(rpm, { env: {}, run }),
		/TAURI_SIGNING_PRIVATE_KEY/,
	);
	assert.equal(await readFile(deb, "utf8"), "original");
	assert.equal(await readFile(rpm, "utf8"), "original");
});

test(
	"a real deb loses only the webview dependencies",
	{ skip: !available("dpkg-deb") },
	async (t) => {
		const root = await workspace(t);
		const tree = path.join(root, "tree");
		await mkdir(path.join(tree, "DEBIAN"), { recursive: true });
		await mkdir(path.join(tree, "usr/bin"), { recursive: true });
		await mkdir(path.join(tree, "usr/lib/cap"), { recursive: true });
		await writeFile(path.join(tree, "usr/bin/Cap"), "#!/bin/sh\n", {
			mode: 0o755,
		});
		const library = Buffer.alloc(4096, 7);
		for (const name of ["libonnxruntime.so", "libonnxruntime.so.1"]) {
			await writeFile(path.join(tree, "usr/lib/cap", name), library, {
				mode: 0o755,
			});
		}
		await writeFile(
			path.join(tree, "DEBIAN/md5sums"),
			capture("sh", [
				"-c",
				'cd "$1" && md5sum usr/bin/Cap usr/lib/cap/libonnxruntime.so usr/lib/cap/libonnxruntime.so.1',
				"sh",
				tree,
			]),
		);
		await writeFile(
			path.join(tree, "DEBIAN/control"),
			[
				"Package: cap",
				"Version: 0.6.1",
				"Architecture: amd64",
				"Maintainer: cap",
				"Installed-Size: 12",
				"Depends: libva2, libasound2t64 | libasound2, libwebkit2gtk-4.1-0, libgtk-3-0",
				"Description: Beautiful screen recordings, owned by you.",
				"",
			].join("\n"),
		);
		const deb = path.join(root, "Cap_0.6.1_amd64.deb");
		capture("dpkg-deb", ["--root-owner-group", "-Zgzip", "--build", tree, deb]);
		await writeFile(`${deb}.sig`, "stale");
		await finalizeGpuiDeb(deb, { unsigned: true });
		assert.equal(
			capture("dpkg-deb", ["--field", deb, "Depends"]).trim(),
			"libva2, libasound2t64 | libasound2",
		);
		assert.equal(
			capture("dpkg-deb", ["--field", deb, "Package"]).trim(),
			"cap",
		);
		const contents = capture("dpkg-deb", ["--contents", deb]);
		assert.match(contents, /-rwxr-xr-x root\/root .* \.\/usr\/bin\/Cap/);
		assert.match(
			contents,
			/lrwxrwxrwx root\/root .* \.\/usr\/lib\/cap\/libonnxruntime\.so -> libonnxruntime\.so\.1/,
		);
		assert.equal(
			capture("dpkg-deb", ["--field", deb, "Installed-Size"]).trim(),
			"8",
		);
		const control = path.join(root, "control");
		capture("dpkg-deb", ["--control", deb, control]);
		const sums = await readFile(path.join(control, "md5sums"), "utf8");
		assert.doesNotMatch(sums, /libonnxruntime\.so$/m);
		assert.match(sums, /libonnxruntime\.so\.1$/m);
		assert.match(capture("ar", ["t", deb]), /data\.tar\.xz/);
		await assert.rejects(readFile(`${deb}.sig`));
	},
);

test(
	"a real rpm keeps its files and metadata without the webview requirements",
	{ skip: !available("rpmbuild") || !available("bsdtar") },
	async (t) => {
		const root = await workspace(t);
		const top = path.join(root, "rpmbuild");
		for (const directory of [
			"BUILD",
			"BUILDROOT",
			"RPMS",
			"SOURCES",
			"SPECS",
		]) {
			await mkdir(path.join(top, directory), { recursive: true });
		}
		const spec = path.join(top, "SPECS/cap.spec");
		await writeFile(
			spec,
			[
				"Name: cap",
				"Version: 0.6.1",
				"Release: 1",
				"Summary: Beautiful screen recordings, owned by you.",
				"License: AGPL-3.0",
				"AutoReqProv: no",
				"Requires: libva",
				"Requires: libwebkit2gtk-4.1.so.0()(64bit)",
				"Requires: libgtk-3.so.0()(64bit)",
				"",
				"%description",
				"Beautiful screen recordings, owned by you.",
				"",
				"%install",
				'mkdir -p "%{buildroot}/usr/bin" "%{buildroot}/usr/lib/Cap" "%{buildroot}/usr/lib/cap"',
				"printf 'cap' > \"%{buildroot}/usr/bin/Cap\"",
				"printf 'music' > \"%{buildroot}/usr/lib/Cap/track one.mp3\"",
				"printf 'onnx' > \"%{buildroot}/usr/lib/cap/libonnxruntime.so.1\"",
				"printf 'onnx' > \"%{buildroot}/usr/lib/cap/libonnxruntime.so\"",
				'ln -s Cap "%{buildroot}/usr/bin/cap"',
				"",
				"%files",
				'%attr(0755,root,root) "/usr/bin/Cap"',
				'%attr(-,root,root) "/usr/bin/cap"',
				'%dir %attr(0755,root,root) "/usr/lib/Cap"',
				'%attr(0644,root,root) "/usr/lib/Cap/track one.mp3"',
				'%attr(0755,root,root) "/usr/lib/cap/libonnxruntime.so"',
				'%attr(0755,root,root) "/usr/lib/cap/libonnxruntime.so.1"',
				"",
			].join("\n"),
		);
		const output = path.join(root, "out");
		capture("rpmbuild", [
			"-bb",
			spec,
			"--define",
			`_topdir ${top}`,
			"--define",
			`_rpmdir ${output}`,
			"--define",
			"_rpmfilename Cap-0.6.1-1.x86_64.rpm",
			"--define",
			"_binary_payload w9.zstdio",
			"--define",
			"_build_id_links none",
			"--define",
			"debug_package %{nil}",
			"--define",
			"__arch_install_post %{nil}",
			"--define",
			"__os_install_post %{nil}",
			"--target",
			"x86_64",
		]);
		const rpm = path.join(output, "Cap-0.6.1-1.x86_64.rpm");
		const files = (file) =>
			capture("rpm", [
				"-qp",
				"--queryformat",
				"[%{FILEMODES:octal} %{FILEUSERNAME}:%{FILEGROUPNAME} %{FILENAMES}\\n]",
				file,
			]);
		const before = files(rpm);
		await finalizeGpuiRpm(rpm, { unsigned: true });
		assert.deepEqual(
			capture("rpm", ["-qpR", rpm])
				.split("\n")
				.filter((line) => line && !line.startsWith("rpmlib(")),
			["libva"],
		);
		assert.equal(
			files(rpm),
			before.replace(
				"100755 root:root /usr/lib/cap/libonnxruntime.so\n",
				"120777 root:root /usr/lib/cap/libonnxruntime.so\n",
			),
		);
		assert.match(
			capture("rpm", [
				"-qp",
				"--queryformat",
				"[%{FILENAMES} -> %{FILELINKTOS}\\n]",
				rpm,
			]),
			/\/usr\/lib\/cap\/libonnxruntime\.so -> libonnxruntime\.so\.1\n/,
		);
		assert.equal(
			capture("rpm", [
				"-qp",
				"--queryformat",
				"%{NAME} %{VERSION}-%{RELEASE} %{ARCH} %{PAYLOADCOMPRESSOR} %{SUMMARY}",
				rpm,
			]),
			"cap 0.6.1-1 x86_64 zstd Beautiful screen recordings, owned by you.",
		);
		assert.match(capture("rpm", ["-Kv", rpm]), /Payload SHA256 digest: OK/);
	},
);
