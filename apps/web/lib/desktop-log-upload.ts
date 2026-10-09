import { z } from "zod";
import { analyzeDesktopDiagnostics } from "./desktop-diagnostic-analysis";

const MAX_CONTEXT_BYTES = 512 * 1024;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

type DesktopLogUpload = {
	log: string;
	os?: string;
	version?: string;
	diagnostics?: string;
	report?: string;
	context?: string;
	user?: { email: string; id: string };
};

export function confirmedDesktopLogWebhookUrl(value: string): URL {
	const url = new URL(value);
	url.searchParams.set("wait", "true");
	return url;
}

function parseAttachment(value: string | undefined, maxBytes: number) {
	if (value === undefined) return { status: "not_provided" };
	if (value.length > maxBytes || Buffer.byteLength(value, "utf8") > maxBytes) {
		return { status: "omitted_size_limit" };
	}
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return { status: "invalid_object" };
		}
		if (
			"capLogUploadOmission" in parsed &&
			parsed.capLogUploadOmission === "size_limit"
		) {
			return { status: "omitted_size_limit" };
		}
		return { status: "included", value: parsed };
	} catch {
		return { status: "invalid_json" };
	}
}

export function createDesktopLogUpload(input: DesktopLogUpload): FormData {
	const diagnostics = parseAttachment(input.diagnostics, MAX_CONTEXT_BYTES);
	const report = parseAttachment(input.report, MAX_REPORT_BYTES);
	const context = parseAttachment(input.context, MAX_CONTEXT_BYTES);
	const validated = diagnosticsSchema.safeParse(diagnostics.value);
	const diagnosticsContent = validated.success
		? formatDiagnosticsForDiscord(validated.data)
		: "";
	const uploadId = crypto.randomUUID();
	const analysis = analyzeDesktopDiagnostics(input.log, context.value);
	const attachment = {
		schemaVersion: 1,
		uploadId,
		receivedAt: new Date().toISOString(),
		os: input.os,
		version: input.version,
		diagnostics: diagnostics.value,
		report: report.value,
		context: context.value,
		analysis,
		coverage: {
			diagnostics: diagnostics.status,
			diagnosticsSummary: validated.success ? "available" : "unavailable",
			report: report.status,
			context: context.status,
		},
	};
	const form = new FormData();
	form.append(
		"files[0]",
		new Blob([input.log], { type: "text/plain" }),
		`cap-desktop-${uploadId}.log`,
	);
	form.append(
		"files[1]",
		new Blob([JSON.stringify(attachment)], { type: "application/json" }),
		`cap-diagnostics-${uploadId}.json`,
	);
	const content = [
		"📋 **New Log File Uploaded**",
		`**Upload:** ${uploadId}`,
		input.user ? `**User:** ${input.user.email} (${input.user.id})` : null,
		input.os ? `**Platform:** ${input.os}` : null,
		input.version ? `**App Version:** ${input.version}` : null,
		`**Operations:** ${analysis.counts.observedOperations} observed; ${analysis.counts.returnedError} returned errors; ${analysis.counts.noTerminalRecord} without a completion record; ${analysis.counts.healthObservations} health observations`,
		diagnosticsContent || null,
		`**Context:** ${context.status}; **Report:** ${report.status}`,
	]
		.filter((line): line is string => line !== null)
		.join("\n")
		.slice(0, 1950);
	form.append(
		"payload_json",
		JSON.stringify({ content, allowed_mentions: { parse: [] } }),
	);
	return form;
}

export const diagnosticsSchema = z.object({
	system: z
		.object({
			windowsVersion: z
				.object({
					displayName: z.string(),
					meetsRequirements: z.boolean().nullish(),
					isWindows11: z.boolean().nullish(),
				})
				.nullish(),
			macosVersion: z.object({ displayName: z.string() }).nullish(),
			linuxVersion: z.object({ displayName: z.string() }).nullish(),
			gpuInfo: z
				.object({
					vendor: z.string(),
					description: z.string(),
					dedicatedVideoMemoryMb: z.number().nullish(),
					isSoftwareAdapter: z.boolean().nullish(),
					isBasicRenderDriver: z.boolean().nullish(),
					supportsHardwareEncoding: z.boolean().nullish(),
				})
				.nullish(),
			allGpus: z
				.object({
					gpus: z.array(
						z.object({
							vendor: z.string(),
							description: z.string(),
							dedicatedVideoMemoryMb: z.number().nullish(),
						}),
					),
					isMultiGpuSystem: z.boolean().nullish(),
					hasDiscreteGpu: z.boolean().nullish(),
				})
				.nullish(),
			renderingStatus: z
				.object({
					isUsingSoftwareRendering: z.boolean().nullish(),
					isUsingBasicRenderDriver: z.boolean().nullish(),
					hardwareEncodingAvailable: z.boolean().nullish(),
					warningMessage: z.string().nullish(),
				})
				.nullish(),
			availableEncoders: z.array(z.string()).nullish(),
			graphicsCaptureSupported: z.boolean().nullish(),
			screenCaptureSupported: z.boolean().nullish(),
			d3D11VideoProcessorAvailable: z.boolean().nullish(),
		})
		.nullish(),
	cameras: z
		.array(
			z.union([
				z.string(),
				z
					.object({ displayName: z.string() })
					.transform((camera) => camera.displayName),
			]),
		)
		.nullish(),
	microphones: z
		.array(
			z.union([
				z.string(),
				z
					.object({ name: z.string() })
					.transform((microphone) => microphone.name),
			]),
		)
		.nullish(),
	permissions: z
		.object({
			screenRecording: z.string().nullish(),
			camera: z.string().nullish(),
			microphone: z.string().nullish(),
		})
		.nullish(),
});

export function formatDiagnosticsForDiscord(
	diagnostics: z.infer<typeof diagnosticsSchema>,
): string {
	const lines: string[] = [];
	const sys = diagnostics.system;

	if (sys?.windowsVersion?.displayName) {
		lines.push(`**OS:** ${sys.windowsVersion.displayName}`);
	} else if (sys?.macosVersion?.displayName) {
		lines.push(`**OS:** ${sys.macosVersion.displayName}`);
	} else if (sys?.linuxVersion?.displayName) {
		lines.push(`**OS:** ${sys.linuxVersion.displayName}`);
	}

	if (sys?.gpuInfo) {
		const gpu = sys.gpuInfo;
		let gpuLine = `**GPU:** ${gpu.description}`;
		if (gpu.vendor) gpuLine += ` (${gpu.vendor})`;
		if (gpu.dedicatedVideoMemoryMb)
			gpuLine += ` - ${gpu.dedicatedVideoMemoryMb}MB VRAM`;
		lines.push(gpuLine);

		const flags: string[] = [];
		if (gpu.isSoftwareAdapter) flags.push("⚠️ Software Adapter");
		if (gpu.isBasicRenderDriver) flags.push("⚠️ Basic Render Driver");
		if (gpu.supportsHardwareEncoding === false) flags.push("❌ No HW Encoding");
		if (gpu.supportsHardwareEncoding === true) flags.push("✅ HW Encoding");
		if (flags.length > 0) lines.push(`**GPU Status:** ${flags.join(", ")}`);
	}

	if (sys?.allGpus?.gpus && sys.allGpus.gpus.length > 1) {
		const gpuList = sys.allGpus.gpus
			.map((g) => `${g.description} (${g.vendor})`)
			.join(", ");
		lines.push(`**All GPUs:** ${gpuList}`);
	}

	if (sys?.renderingStatus?.warningMessage) {
		lines.push(`**⚠️ Warning:** ${sys.renderingStatus.warningMessage}`);
	}

	const captureSupported =
		sys?.graphicsCaptureSupported ?? sys?.screenCaptureSupported;
	if (captureSupported != null) {
		lines.push(
			`**Screen Capture:** ${captureSupported ? "✅ Supported" : "❌ Not Supported"}`,
		);
	}

	if (sys?.d3D11VideoProcessorAvailable != null) {
		lines.push(
			`**D3D11 Video Processor:** ${sys.d3D11VideoProcessorAvailable ? "✅" : "❌"}`,
		);
	}

	if (sys?.availableEncoders && sys.availableEncoders.length > 0) {
		lines.push(`**Encoders:** ${sys.availableEncoders.join(", ")}`);
	}

	if (diagnostics.permissions) {
		const perms = diagnostics.permissions;
		const permList = [
			perms.screenRecording && `Screen: ${perms.screenRecording}`,
			perms.camera && `Camera: ${perms.camera}`,
			perms.microphone && `Mic: ${perms.microphone}`,
		]
			.filter(Boolean)
			.join(", ");
		if (permList) lines.push(`**Permissions:** ${permList}`);
	}

	if (diagnostics.cameras && diagnostics.cameras.length > 0) {
		lines.push(
			`**Cameras (${diagnostics.cameras.length}):** ${diagnostics.cameras.join(", ")}`,
		);
	} else if (diagnostics.cameras) {
		lines.push("**Cameras:** None detected");
	}

	if (diagnostics.microphones && diagnostics.microphones.length > 0) {
		lines.push(
			`**Mics (${diagnostics.microphones.length}):** ${diagnostics.microphones.join(", ")}`,
		);
	} else if (diagnostics.microphones) {
		lines.push("**Mics:** None detected");
	}

	return lines.join("\n");
}
