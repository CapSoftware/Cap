import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
	new URL("./build-linux-arch-package.sh", import.meta.url),
);
const available = (command) =>
	spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;
const canPackage =
	process.platform === "linux" &&
	process.getuid() !== 0 &&
	["makepkg", "vercmp", "bsdtar", "ar", "fakeroot", "zstd"].every(available);

test(
	"Arch prereleases upgrade to stable and supersede existing packages",
	{ skip: !canPackage },
	async (t) => {
		const root = await mkdtemp(path.join(tmpdir(), "cap-arch-packages-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const temporary = path.join(root, "tmp");
		await mkdir(temporary);
		const config = path.join(root, "makepkg.conf");
		await writeFile(
			config,
			[
				await readFile("/etc/makepkg.conf", "utf8"),
				"BUILDENV=(!distcc !color !ccache !check !sign)",
				'PACKAGER="Synthetic fixture <fixture@example.invalid>"',
				"OPTIONS=(!strip !docs !libtool !staticlibs emptydirs !zipman !purge !debug !lto)",
				"COMPRESSZST=(zstd -c -T1 -)",
				"PKGEXT='.pkg.tar.zst'",
				"",
			].join("\n"),
		);
		const env = {
			...process.env,
			TMPDIR: temporary,
			MAKEPKG_CONF: config,
			CARCH: "x86_64",
		};
		function run(command, args, cwd = root) {
			const result = spawnSync(command, args, {
				cwd,
				env,
				encoding: "utf8",
				timeout: 30_000,
			});
			assert.ifError(result.error);
			assert.equal(
				result.status,
				0,
				`${command}: ${result.stdout}\n${result.stderr}`,
			);
			return result.stdout.trim();
		}
		const versions = [
			"0.6.2-nightly.202610210300",
			"0.6.2-nightly.202610220300",
			"0.6.2-rc.1",
			"0.6.2-1",
			"0.6.2",
		];
		const packages = [];
		for (const version of versions) {
			const directory = path.join(root, version);
			const control = path.join(directory, "control");
			const payload = path.join(directory, "payload");
			const output = path.join(directory, "output");
			await mkdir(control, { recursive: true });
			await mkdir(path.join(payload, "usr/bin"), { recursive: true });
			await mkdir(path.join(payload, "usr/lib/cap"), { recursive: true });
			await mkdir(output);
			await writeFile(path.join(directory, "debian-binary"), "2.0\n");
			await writeFile(
				path.join(control, "control"),
				`Package: cap\nVersion: ${version}\nArchitecture: amd64\nMaintainer: Synthetic fixture <fixture@example.invalid>\nDescription: Synthetic packaging fixture\n`,
			);
			const binaryContents =
				"#!/bin/sh\nprintf '%s\\n' 'synthetic Cap binary'\n";
			for (const binary of ["Cap", "cap-cli", "cap-muxer"]) {
				await writeFile(path.join(payload, "usr/bin", binary), binaryContents, {
					mode: 0o755,
				});
			}
			await writeFile(
				path.join(payload, "usr/lib/cap/package-format"),
				"deb\n",
			);
			run("bsdtar", [
				"-czf",
				path.join(directory, "control.tar.gz"),
				"-C",
				control,
				".",
			]);
			run("bsdtar", [
				"-czf",
				path.join(directory, "data.tar.gz"),
				"-C",
				payload,
				".",
			]);
			const deb = path.join(directory, "Cap.deb");
			run(
				"ar",
				["rcD", deb, "debian-binary", "control.tar.gz", "data.tar.gz"],
				directory,
			);
			run("bash", [script, deb, output]);
			const files = (await readdir(output)).filter((file) =>
				file.endsWith(".pkg.tar.zst"),
			);
			assert.equal(files.length, 1);
			const artifact = path.join(output, files[0]);
			const metadata = run("bsdtar", ["-xOf", artifact, ".PKGINFO"]);
			const pkgver = /^pkgver = (.+)$/m.exec(metadata)?.[1];
			assert.ok(pkgver);
			assert.match(pkgver, /^1:/);
			assert.equal(
				files[0],
				`cap-bin-${pkgver.replace(/^1:/, "")}-x86_64.pkg.tar.zst`,
			);
			packages.push(pkgver);
			assert.match(metadata, /^arch = x86_64$/m);
			assert.ok(
				metadata.includes(`provides = cap=${pkgver.replace(/-1$/, "")}\n`),
			);
			assert.equal(
				run("bsdtar", ["-xOf", artifact, "usr/lib/cap/package-format"]),
				"arch",
			);
			const extracted = path.join(directory, "extracted");
			await mkdir(extracted);
			run("bsdtar", ["-xf", artifact, "-C", extracted]);
			for (const binary of ["Cap", "cap-cli", "cap-muxer"]) {
				assert.equal(
					await readFile(path.join(extracted, "usr/bin", binary), "utf8"),
					binaryContents,
				);
				assert.equal(
					run(path.join(extracted, "usr/bin", binary), []),
					"synthetic Cap binary",
				);
			}
		}
		for (const prerelease of packages.slice(0, -1)) {
			assert.equal(run("vercmp", [prerelease, packages.at(-1)]), "-1");
		}
		assert.equal(run("vercmp", [packages[1], packages[0]]), "1");
		assert.equal(
			run("vercmp", [packages[1], "0.6.2_nightly.202610210300-1"]),
			"1",
		);
		assert.equal(run("vercmp", [packages.at(-1), "0.6.2-1"]), "1");
	},
);
