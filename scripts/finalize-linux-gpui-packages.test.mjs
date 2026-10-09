import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	finalizeGpuiDeb,
	finalizeGpuiRpm,
	parseRpmFiles,
	rpmFileEntry,
	rpmSpec,
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

test("deb finalization signs the rebuilt package before replacing it", async (t) => {
	const root = await workspace(t);
	const deb = path.join(root, "Cap_0.6.1_amd64.deb");
	await writeFile(deb, "original");
	await writeFile(`${deb}.sig`, "original signature");
	const calls = [];
	const env = { TAURI_SIGNING_PRIVATE_KEY: "key" };
	await finalizeGpuiDeb(deb, {
		env,
		run: async (command, args, options) => {
			calls.push([command, ...args.slice(0, 4)]);
			if (command === "dpkg-deb" && args[0] === "--raw-extract") {
				await mkdir(path.join(args[2], "DEBIAN"), { recursive: true });
				await writeFile(
					path.join(args[2], "DEBIAN/control"),
					"Package: cap\nDepends: libva2, libwebkit2gtk-4.1-0, libgtk-3-0\n",
				);
			} else if (command === "dpkg-deb") {
				assert.deepEqual(args.slice(0, 3), [
					"--root-owner-group",
					"-Zxz",
					"--build",
				]);
				assert.equal(
					await readFile(path.join(args[3], "DEBIAN/control"), "utf8"),
					"Package: cap\nDepends: libva2\n",
				);
				await writeFile(args[4], "rebuilt");
			} else {
				assert.deepEqual(args.slice(0, 4), ["run", "tauri", "signer", "sign"]);
				assert.equal(options.env.TAURI_PRIVATE_KEY, "key");
				assert.equal(await readFile(args[4], "utf8"), "rebuilt");
				await writeFile(`${args[4]}.sig`, "rebuilt signature");
			}
			return {};
		},
	});
	assert.deepEqual(
		calls.map(([command]) => command),
		["dpkg-deb", "dpkg-deb", "bun"],
	);
	assert.equal(await readFile(deb, "utf8"), "rebuilt");
	assert.equal(await readFile(`${deb}.sig`, "utf8"), "rebuilt signature");
});

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
		await writeFile(path.join(tree, "usr/bin/Cap"), "#!/bin/sh\n", {
			mode: 0o755,
		});
		await writeFile(
			path.join(tree, "DEBIAN/control"),
			[
				"Package: cap",
				"Version: 0.6.1",
				"Architecture: amd64",
				"Maintainer: cap",
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
		assert.match(
			capture("dpkg-deb", ["--contents", deb]),
			/-rwxr-xr-x root\/root .* \.\/usr\/bin\/Cap/,
		);
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
				'mkdir -p "%{buildroot}/usr/bin" "%{buildroot}/usr/lib/Cap"',
				"printf 'cap' > \"%{buildroot}/usr/bin/Cap\"",
				"printf 'music' > \"%{buildroot}/usr/lib/Cap/track one.mp3\"",
				'ln -s Cap "%{buildroot}/usr/bin/cap"',
				"",
				"%files",
				'%attr(0755,root,root) "/usr/bin/Cap"',
				'%attr(-,root,root) "/usr/bin/cap"',
				'%dir %attr(0755,root,root) "/usr/lib/Cap"',
				'%attr(0644,root,root) "/usr/lib/Cap/track one.mp3"',
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
		assert.equal(files(rpm), before);
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
