import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";

const execFile = promisify(execFileCallback);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

// A stored (uncompressed) zip, so the fixture needs no zip tool.
function zipArchive(name, contents) {
	const fileName = Buffer.from(name);
	const data = Buffer.from(contents);
	const header = (signature, size) => {
		const buffer = Buffer.alloc(size);
		buffer.writeUInt32LE(signature, 0);
		return buffer;
	};
	const local = header(0x04034b50, 30);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(0x21, 12);
	local.writeUInt32LE(crc32(data), 14);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(fileName.length, 26);
	const central = header(0x02014b50, 46);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(0x21, 14);
	central.writeUInt32LE(crc32(data), 16);
	central.writeUInt32LE(data.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(fileName.length, 28);
	const centralOffset = local.length + fileName.length + data.length;
	const end = header(0x06054b50, 22);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + fileName.length, 12);
	end.writeUInt32LE(centralOffset, 16);
	return Buffer.concat([local, fileName, data, central, fileName, end]);
}

test(
	"setup retries failed downloads without poisoning the archive cache",
	{
		skip: process.platform !== "linux" && "Linux setup fixture",
		timeout: 60_000,
	},
	async (t) => {
		const fixture = mkdtempSync(path.join(tmpdir(), "cap-setup-"));
		t.after(() => rmSync(fixture, { recursive: true, force: true }));
		for (const file of [
			"package.json",
			"scripts/setup.js",
			"scripts/linux-bundle-config.mjs",
			"apps/desktop-gpui/tauri.conf.json",
		]) {
			const destination = path.join(fixture, file);
			mkdirSync(path.dirname(destination), { recursive: true });
			copyFileSync(path.join(repositoryRoot, file), destination);
		}

		const setupPath = path.join(fixture, "scripts/setup.js");
		const setupSource = readFileSync(setupPath, "utf8");
		const onnxVersion = setupSource.match(
			/const ONNX_RUNTIME_VERSION = "([^"]+)"/,
		)[1];
		const pinnedHash = setupSource.match(
			new RegExp(`"${onnxVersion.replaceAll(".", "\\.")}": "([0-9a-f]{64})"`),
		)[1];

		const nativeName = "native-deps-x86_64-linux-gnu.tar.xz";
		const onnxId = `microsoft.ml.onnxruntime.${onnxVersion}`;
		const nativeUrl = `/spacedriveapp/native-deps/releases/download/v0.26/${nativeName}`;
		const onnxUrl = `/v3-flatcontainer/microsoft.ml.onnxruntime/${onnxVersion}/${onnxId}.nupkg`;
		const nativeLibrary = "synthetic native library\n";
		const onnxLibrary = "synthetic ONNX library\n";
		const archives = new Map();
		{
			const archive = path.join(fixture, "assets", nativeName);
			const directory = `${archive}.contents`;
			mkdirSync(path.join(directory, "lib"), { recursive: true });
			writeFileSync(
				path.join(directory, "lib/libavcodec.so.61"),
				nativeLibrary,
			);
			await execFile("tar", ["-cJf", archive, "-C", directory, "."], {
				signal: t.signal,
			});
			archives.set(nativeUrl, readFileSync(archive));
		}
		archives.set(
			onnxUrl,
			zipArchive("runtimes/linux-x64/native/libonnxruntime.so", onnxLibrary),
		);
		// The synthetic package stands in for Microsoft's, so pin its hash in
		// this fixture's copy of setup.js.
		const onnxHash = createHash("sha256")
			.update(archives.get(onnxUrl))
			.digest("hex");
		writeFileSync(setupPath, setupSource.replaceAll(pinnedHash, onnxHash));

		let failNative = true;
		let tamperOnnx = false;
		let networkFailures = 0;
		const requests = [];
		const server = createServer((request, response) => {
			requests.push(request.url);
			if (failNative && request.url === nativeUrl) {
				response.writeHead(503).end("Service Unavailable\n");
				return;
			}
			if (request.url === nativeUrl && networkFailures > 0) {
				networkFailures--;
				request.socket.destroy();
				return;
			}
			const archive = archives.get(request.url);
			response.writeHead(archive ? 200 : 404);
			if (archive && tamperOnnx && request.url === onnxUrl)
				response.end(Buffer.concat([archive, Buffer.from("tampered")]));
			else response.end(archive ?? "Unexpected setup download");
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		t.after(async () => {
			server.closeAllConnections();
			await promisify(server.close.bind(server))();
		});
		const origin = `http://127.0.0.1:${server.address().port}`;
		const preload = path.join(fixture, "http-fixture.mjs");
		writeFileSync(
			preload,
			`const networkFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
	const url = new URL(input);
	if (!["https://github.com", "https://api.nuget.org"].includes(url.origin))
		throw new Error(\`Unexpected external request: \${url}\`);
	return networkFetch(new URL(url.pathname, ${JSON.stringify(origin)}), options);
};
`,
		);
		const runSetup = () =>
			execFile(process.execPath, ["--import", preload, "scripts/setup.js"], {
				cwd: fixture,
				signal: t.signal,
				timeout: 20_000,
				env: {
					...process.env,
					NODE_OPTIONS: "",
					RUST_TARGET_TRIPLE: "x86_64-unknown-linux-gnu",
					CAP_USE_SCCACHE: "0",
					TMPDIR: fixture,
				},
			}).then(
				({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
				(error) => {
					assert.equal(typeof error.code, "number", error.message);
					return error;
				},
			);

		const cache = path.join(fixture, "target", `v0.26-${nativeName}`);
		const failed = await runSetup();
		assert.equal(failed.code, 1, failed.stderr);
		assert.deepEqual(requests, [nativeUrl]);
		assert.equal(
			existsSync(cache),
			false,
			"failed downloads must not be cached",
		);
		assert.match(failed.stderr, /HTTP 503/);

		failNative = false;
		networkFailures = 3;
		requests.length = 0;
		const disconnected = await runSetup();
		assert.equal(disconnected.code, 1, disconnected.stderr);
		assert.deepEqual(requests, [nativeUrl, nativeUrl, nativeUrl]);
		assert.equal(existsSync(cache), false);
		assert.match(disconnected.stderr, /UND_ERR_SOCKET/);

		networkFailures = 2;
		for (const expectedRequests of [
			[nativeUrl, nativeUrl, nativeUrl, onnxUrl],
			[],
		]) {
			requests.length = 0;
			const result = await runSetup();
			assert.equal(result.code, 0, result.stderr);
			assert.deepEqual(requests, expectedRequests);
			assert.deepEqual(readFileSync(cache), archives.get(nativeUrl));
			for (const [name, contents] of [
				["libavcodec.so.61", nativeLibrary],
				["libonnxruntime.so", onnxLibrary],
				["libonnxruntime.so.1", onnxLibrary],
			]) {
				for (const directory of [
					"target/debug",
					"target/release",
					"target/x86_64-unknown-linux-gnu/debug",
					"target/x86_64-unknown-linux-gnu/release",
				]) {
					assert.equal(
						readFileSync(path.join(fixture, directory, name), "utf8"),
						contents,
					);
				}
				const gpui = path.join(fixture, "apps/desktop-gpui");
				const config = JSON.parse(
					readFileSync(path.join(gpui, "tauri.linux.conf.json"), "utf8"),
				);
				const source = config.bundle.linux.deb.files[`/usr/lib/cap/${name}`];
				assert.equal(
					readFileSync(path.resolve(gpui, source), "utf8"),
					contents,
				);
			}
			const cargo = readFileSync(
				path.join(fixture, ".cargo/config.toml"),
				"utf8",
			);
			assert.match(cargo, /\[target\.x86_64-unknown-linux-gnu\]/);
			assert.match(
				cargo,
				/ORT_DYLIB_PATH = .*native-deps\/onnxruntime\/lib\/libonnxruntime\.so/,
			);
		}

		const onnxCache = path.join(fixture, "target", `${onnxId}.zip`);
		const onnxOutput = path.join(fixture, "target/native-deps/onnxruntime");
		rmSync(onnxCache);
		rmSync(onnxOutput, { recursive: true });
		tamperOnnx = true;
		requests.length = 0;
		const tampered = await runSetup();
		assert.equal(tampered.code, 1, tampered.stderr);
		assert.deepEqual(requests, [onnxUrl]);
		assert.match(tampered.stderr, /SHA-256 mismatch/);
		assert.equal(
			existsSync(onnxCache),
			false,
			"a package with the wrong hash must not be cached",
		);
		assert.equal(
			existsSync(path.join(onnxOutput, "lib/libonnxruntime.so")),
			false,
		);

		tamperOnnx = false;
		requests.length = 0;
		const verified = await runSetup();
		assert.equal(verified.code, 0, verified.stderr);
		assert.deepEqual(requests, [onnxUrl]);
		assert.equal(
			readFileSync(path.join(onnxOutput, "lib/libonnxruntime.so"), "utf8"),
			onnxLibrary,
		);
	},
);
