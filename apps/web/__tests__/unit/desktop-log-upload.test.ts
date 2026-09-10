import { describe, expect, it } from "vitest";
import { analyzeDesktopDiagnostics } from "@/lib/desktop-diagnostic-analysis";
import {
	confirmedDesktopLogWebhookUrl,
	createDesktopLogUpload,
	diagnosticsSchema,
} from "@/lib/desktop-log-upload";

describe("desktop diagnostic uploads", () => {
	it("identifies metadata omitted by the desktop request budget", async () => {
		const form = createDesktopLogUpload({
			log: "recent log",
			report: JSON.stringify({ capLogUploadOmission: "size_limit" }),
		});
		const attachment = form.get("files[1]");
		if (!(attachment instanceof Blob)) throw new Error("Missing attachment");
		const parsed = JSON.parse(await attachment.text());
		expect(parsed.coverage.report).toBe("omitted_size_limit");
		expect(parsed.report).toBeUndefined();
	});
	it("requires confirmation of delivery while preserving the destination thread", () => {
		const url = confirmedDesktopLogWebhookUrl(
			"https://discord.com/api/webhooks/test/token?thread_id=123&wait=false",
		);
		expect(url.searchParams.get("wait")).toBe("true");
		expect(url.searchParams.get("thread_id")).toBe("123");
		expect(url.pathname).toBe("/api/webhooks/test/token");
	});
	it("accepts Tauri device objects, GPUI names, and null OS fields", () => {
		const tauri = diagnosticsSchema.parse({
			system: { macosVersion: null },
			cameras: [{ displayName: "Camera", deviceId: "device" }],
			microphones: [{ name: "Microphone", channels: 2 }],
		});
		expect(tauri.cameras).toEqual(["Camera"]);
		expect(tauri.microphones).toEqual(["Microphone"]);
		expect(
			diagnosticsSchema.parse({ cameras: ["Camera"], microphones: [] }),
		).toMatchObject({ cameras: ["Camera"] });
	});

	it("preserves the log, full diagnostic report, and operation context together", async () => {
		const report = { schemaVersion: 1, recentRecordings: [{ mode: "studio" }] };
		const context = {
			operations: { records: [{ operation: "export_mp4", elapsedMs: 123 }] },
		};
		const form = createDesktopLogUpload({
			log: "original log\n",
			diagnostics: JSON.stringify({ hardware: { cpuCores: 8 } }),
			report: JSON.stringify(report),
			context: JSON.stringify(context),
		});
		const log = form.get("files[0]");
		const diagnostic = form.get("files[1]");
		expect(log).toBeInstanceOf(Blob);
		expect(diagnostic).toBeInstanceOf(Blob);
		if (!(log instanceof Blob) || !(diagnostic instanceof Blob)) {
			throw new Error("Missing upload attachments");
		}
		expect(await log.text()).toBe("original log\n");
		const parsed = JSON.parse(await diagnostic.text());
		expect(parsed.report).toEqual(report);
		expect(parsed.context).toEqual(context);
		expect(parsed.diagnostics.hardware.cpuCores).toBe(8);
		expect(parsed.coverage.context).toBe("included");
		expect(
			JSON.parse(String(form.get("payload_json"))).allowed_mentions,
		).toEqual({
			parse: [],
		});
	});

	it("keeps legacy uploads working and makes invalid optional context visible", async () => {
		const form = createDesktopLogUpload({
			log: "legacy log",
			context: "{broken",
			report: "x".repeat(2 * 1024 * 1024 + 1),
		});
		const diagnostic = form.get("files[1]");
		if (!(diagnostic instanceof Blob)) throw new Error("Missing attachment");
		const parsed = JSON.parse(await diagnostic.text());
		expect(parsed.coverage).toMatchObject({
			diagnostics: "not_provided",
			context: "invalid_json",
			report: "omitted_size_limit",
		});
		expect(parsed.report).toBeUndefined();
		expect(parsed.context).toBeUndefined();
	});
});

const record = (overrides: { [key: string]: unknown } = {}) => ({
	schemaVersion: 2,
	operationId: { session: 123, process: 456, sequence: 1 },
	parentOperationId: null,
	revision: 1,
	app: {
		flavor: "tauri",
		version: "test-build",
		sourceRevision: "abc123",
		sourceDirty: false,
		debugBuild: false,
	},
	os: "macos",
	binaryArchitecture: "aarch64",
	operation: "export_worker",
	startedAtUnixMs: 123,
	elapsedMs: 0,
	stage: "started",
	outcome: "in_progress",
	fields: [{ name: "requested_fps", value: 60 }],
	omittedFields: 0,
	...overrides,
});
const logLine = (value: unknown) => `CAP_DIAGNOSTIC ${JSON.stringify(value)}\n`;

describe("desktop diagnostic reconstruction", () => {
	it("analyzes retained context beyond the former two-mebibyte scan limit", () => {
		const analysis = analyzeDesktopDiagnostics(
			logLine(record({ outcome: "returned_error" })) +
				"ordinary log\n".repeat(200_000),
			undefined,
		);
		expect(analysis.counts.returnedError).toBe(1);
		expect(analysis.coverage.logCharactersOmittedFromAnalysis).toBe(0);
	});
	it("handles reversed rotated files and a delayed checkpoint after completion", () => {
		const analysis = analyzeDesktopDiagnostics(
			logLine(record({ revision: 3, outcome: "returned_ok", elapsedMs: 500 })) +
				logLine(record({ revision: 2, stage: "rendering", elapsedMs: 600 })) +
				logLine(record()),
			{ operations: { records: [record({ revision: 2 })] } },
		);
		expect(analysis.counts.returnedOk).toBe(1);
		expect(analysis.counts.noTerminalRecord).toBe(0);
		expect(analysis.operations[0]?.elapsedMs).toBe(500);
		expect(
			analysis.operations[0]?.stages.map((stage) => stage.revision),
		).toEqual([1, 2, 3]);
		expect(analysis.operations[0]?.stages[1]).toEqual({
			revision: 2,
			stage: "rendering",
			elapsedMs: 600,
			outcome: "in_progress",
		});
	});

	it("keeps the newest duplicate stage in either input order", () => {
		const stale = record({ revision: 2, elapsedMs: 1 });
		const current = record({ revision: 2, stage: "rendering", elapsedMs: 600 });
		for (const [snapshot, logged] of [
			[stale, current],
			[current, stale],
		]) {
			const analysis = analyzeDesktopDiagnostics(logLine(logged), {
				operations: { records: [snapshot] },
			});
			expect(analysis.operations[0]).toMatchObject({
				stage: "rendering",
				elapsedMs: 600,
				stages: [{ revision: 2, stage: "rendering", elapsedMs: 600 }],
			});
		}
	});

	it("links a failed worker to its parent and retains the build and settings", () => {
		const parent = record({ revision: 2, outcome: "returned_error" });
		const worker = record({
			operation: "export_mp4",
			operationId: { session: 234, process: 567, sequence: 1 },
			parentOperationId: parent.operationId,
		});
		const analysis = analyzeDesktopDiagnostics(
			logLine(parent) + logLine(worker),
			undefined,
		);
		expect(analysis.counts.returnedError).toBe(1);
		expect(analysis.counts.noTerminalRecord).toBe(1);
		expect(analysis.operations[1]?.parentId).toBe(analysis.operations[0]?.id);
		expect(analysis.operations[1]?.fields.requested_fps).toBe(60);
		expect(analysis.operations[1]?.app?.version).toBe("test-build");
	});

	it("exposes corrupt, unsupported and lost data without inventing a crash", () => {
		const analysis = analyzeDesktopDiagnostics(
			`legacy log\nCAP_DIAGNOSTIC {broken\n${logLine(record())}${logLine({ schemaVersion: 99 })}`,
			{ operations: { journalWriteFailures: 2, loggerDroppedMessages: 3 } },
		);
		expect(analysis.coverage).toMatchObject({
			invalidRecords: 1,
			unsupportedRecords: 1,
			journalWriteFailures: 2,
			loggerDroppedMessages: 3,
		});
		expect(analysis.counts.returnedError).toBe(0);
		expect(analysis.counts.noTerminalRecord).toBe(1);
		expect(analysis.missingTerminalSemantics).toBe(
			"may_be_active_interrupted_or_missing_data",
		);
	});

	it("keeps recent incidents when retained history exceeds the operation limit", () => {
		const log = Array.from({ length: 4200 }, (_, sequence) =>
			logLine(
				record({ operationId: { session: 123, process: 456, sequence } }),
			),
		).join("");
		const analysis = analyzeDesktopDiagnostics(log, undefined);
		expect(analysis.operations).toHaveLength(4096);
		expect(analysis.coverage.recordsOmittedForOperationLimit).toBe(104);
		expect(
			analysis.operations.some((item) => item.operationId.sequence === 4199),
		).toBe(true);
		expect(
			analysis.operations.some((item) => item.operationId.sequence === 0),
		).toBe(false);
		const current = record({
			operationId: { session: 123, process: 456, sequence: 4200 },
		});
		const withSnapshot = analyzeDesktopDiagnostics(log, {
			operations: { records: [current] },
		});
		expect(withSnapshot.operations).toHaveLength(4096);
		expect(
			withSnapshot.operations.some(
				(item) => item.operationId.sequence === 4200,
			),
		).toBe(true);
		expect(
			withSnapshot.operations.some(
				(item) => item.operationId.sequence === 4199,
			),
		).toBe(true);
	});

	it("counts excluded records without claiming they are distinct operations", () => {
		const old = [1, 2, 3]
			.map((revision) =>
				logLine(
					record({
						operationId: { session: 123, process: 456, sequence: 0 },
						revision,
					}),
				),
			)
			.join("");
		const recent = Array.from({ length: 4096 }, (_, index) =>
			logLine(
				record({
					operationId: { session: 123, process: 456, sequence: index + 1 },
				}),
			),
		).join("");
		const analysis = analyzeDesktopDiagnostics(old + recent, undefined);
		expect(analysis.operations).toHaveLength(4096);
		expect(analysis.coverage.recordsOmittedForOperationLimit).toBe(3);
	});
});
