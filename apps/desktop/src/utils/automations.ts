import type {
	Action as ActionBinding,
	AutomationActionCheck,
	AutomationExportCompression,
	AutomationRecordingMode,
	AutomationRule as AutomationRuleBinding,
	AutomationsStore as AutomationsStoreBinding,
	AutomationTestReport,
	CaptureTargetKind,
	ClipboardSource,
	Condition,
	ExportDestination,
	ExportFormat,
	ExportProfile as ExportProfileBinding,
	MatchMode,
	Trigger,
} from "~/utils/tauri";
import { commands } from "~/utils/tauri";

export type {
	AutomationActionCheck,
	AutomationRecordingMode,
	AutomationTestReport,
	CaptureTargetKind,
	ClipboardSource,
	Condition,
	ExportDestination,
	ExportFormat,
	MatchMode,
	Trigger,
};

// The specta-generated bindings in `tauri.ts` are the single source of truth for the automation
// data model. Their fields are optional (serde `#[serde(default)]`), but the editor always builds
// fully-populated objects, so strict, fully-required variants are derived here. A change to the Rust
// types regenerates `tauri.ts` and flows through automatically — there is no parallel definition to
// drift out of sync.
type DeepRequired<T> = T extends (infer U)[]
	? DeepRequired<U>[]
	: T extends object
		? { [K in keyof T]-?: DeepRequired<T[K]> }
		: T;

export type ExportCompression = AutomationExportCompression;
export type ExportProfile = DeepRequired<ExportProfileBinding>;
export type Action = DeepRequired<ActionBinding>;
export type ActionType = Action["type"];
export type AutomationRule = DeepRequired<AutomationRuleBinding>;
export type AutomationsStore = DeepRequired<AutomationsStoreBinding>;

export const TRIGGER_LABELS: Record<Trigger, string> = {
	screenshotTaken: "On screenshot taken",
	studioRecordingFinished: "On studio recording finished",
	instantRecordingFinished: "On instant recording finished",
	recordingStarted: "On recording started",
	uploadCompleted: "On upload completed",
	videoImported: "On video imported",
	recordingDeleted: "On recording deleted",
};

export const ACTION_LABELS: Record<ActionType, string> = {
	copyToClipboard: "Copy to clipboard",
	saveToLocation: "Save to location",
	export: "Export with profile",
	upload: "Upload + copy link",
	revealInFileManager: "Reveal in file manager",
	openFile: "Open file",
	runCommand: "Run command",
	webhook: "Send webhook",
	recognizeTextToClipboard: "Recognize text (OCR) to clipboard",
	notify: "Show notification",
	openEditor: "Open editor",
	skipEditor: "Skip editor (headless)",
	applyPreset: "Apply editor preset",
	deleteLocalFiles: "Delete local files",
};

export const CONDITION_LABELS: Record<Condition["type"], string> = {
	captureTargetIs: "Capture target is",
	recordingModeIs: "Recording mode is",
	durationAtLeast: "Duration at least (seconds)",
	durationAtMost: "Duration at most (seconds)",
	windowTitleContains: "Window title contains",
	organizationIs: "Organization is",
};

export const DANGEROUS_ACTIONS: ActionType[] = ["runCommand", "webhook"];

type TriggerContextField =
	| "captureTarget"
	| "windowTitle"
	| "recordingMode"
	| "duration"
	| "projectPath"
	| "filePath"
	| "shareLink";

// The contextual data each trigger actually provides at runtime, mirroring the Rust `TriggerContext`
// populated per trigger in `automation.rs`. Used to flag conditions/actions that depend on data a
// trigger never supplies, so they can be surfaced as no-ops in the editor instead of failing silently.
const TRIGGER_CONTEXT: Record<Trigger, readonly TriggerContextField[]> = {
	screenshotTaken: ["captureTarget", "windowTitle", "projectPath", "filePath"],
	studioRecordingFinished: ["recordingMode", "duration", "projectPath"],
	instantRecordingFinished: ["recordingMode", "projectPath", "shareLink"],
	recordingStarted: [],
	uploadCompleted: ["projectPath", "shareLink"],
	videoImported: ["projectPath"],
	recordingDeleted: ["projectPath"],
};

const CONDITION_REQUIRES: Record<
	Condition["type"],
	TriggerContextField | null
> = {
	captureTargetIs: "captureTarget",
	recordingModeIs: "recordingMode",
	durationAtLeast: "duration",
	durationAtMost: "duration",
	windowTitleContains: "windowTitle",
	organizationIs: null,
};

// Each action lists the context fields it can consume; it applies when the trigger provides at least
// one of them. Actions with no entry (notify, runCommand, webhook) always apply.
const ACTION_REQUIRES: Partial<
	Record<ActionType, readonly TriggerContextField[]>
> = {
	copyToClipboard: ["filePath"],
	saveToLocation: ["filePath"],
	openFile: ["filePath"],
	recognizeTextToClipboard: ["filePath"],
	export: ["projectPath"],
	applyPreset: ["projectPath"],
	deleteLocalFiles: ["projectPath"],
	revealInFileManager: ["filePath", "projectPath"],
	openEditor: ["filePath", "projectPath"],
	upload: ["filePath", "projectPath"],
};

// `skipEditor` only does anything for the two triggers whose post-capture window is gated on it.
const SKIP_EDITOR_TRIGGERS: readonly Trigger[] = [
	"screenshotTaken",
	"studioRecordingFinished",
];

export function conditionAppliesToTrigger(
	type: Condition["type"],
	trigger: Trigger,
): boolean {
	const required = CONDITION_REQUIRES[type];
	if (required === null) return false;
	return TRIGGER_CONTEXT[trigger].includes(required);
}

export function actionAppliesToTrigger(
	type: ActionType,
	trigger: Trigger,
): boolean {
	if (type === "skipEditor") return SKIP_EDITOR_TRIGGERS.includes(trigger);
	const required = ACTION_REQUIRES[type];
	if (!required) return true;
	const provided = TRIGGER_CONTEXT[trigger];
	return required.some((field) => provided.includes(field));
}

export function defaultActionForType(type: ActionType): Action {
	switch (type) {
		case "copyToClipboard":
			return { type, source: "raw" };
		case "saveToLocation":
			return { type, dir: "", filenameTemplate: null };
		case "export":
			return {
				type,
				profile: {
					format: "mp4",
					fps: 30,
					resolutionBase: { x: 1920, y: 1080 },
					compression: "web",
					presetName: null,
				},
				destination: "projectFolder",
			};
		case "upload":
			return {
				type,
				organizationId: null,
				copyLink: true,
				openInBrowser: false,
			};
		case "revealInFileManager":
			return { type };
		case "openFile":
			return { type };
		case "runCommand":
			return {
				type,
				program: "",
				args: [],
				cwd: null,
				env: {},
				useShell: false,
			};
		case "webhook":
			return {
				type,
				url: "",
				method: "POST",
				headers: {},
				bodyTemplate: null,
			};
		case "recognizeTextToClipboard":
			return { type };
		case "notify":
			return { type, titleTemplate: "Cap", bodyTemplate: "" };
		case "openEditor":
			return { type };
		case "skipEditor":
			return { type };
		case "applyPreset":
			return { type, name: "" };
		case "deleteLocalFiles":
			return { type };
	}
}

export function defaultConditionForType(type: Condition["type"]): Condition {
	switch (type) {
		case "captureTargetIs":
			return { type, target: "window" };
		case "recordingModeIs":
			return { type, mode: "studio" };
		case "durationAtLeast":
			return { type, secs: 5 };
		case "durationAtMost":
			return { type, secs: 300 };
		case "windowTitleContains":
			return { type, pattern: "" };
		case "organizationIs":
			return { type, id: "" };
	}
}

export function createEmptyRule(): AutomationRule {
	return {
		id: crypto.randomUUID(),
		name: "",
		enabled: true,
		trigger: "screenshotTaken",
		matchMode: "all",
		conditions: [],
		actions: [{ type: "copyToClipboard", source: "raw" }],
	};
}

export async function getAutomations(): Promise<AutomationsStore> {
	return (await commands.getAutomations()) as AutomationsStore;
}

export async function setAutomations(store: AutomationsStore): Promise<void> {
	await commands.setAutomations(store);
}

export async function testAutomation(
	ruleId: string,
): Promise<AutomationTestReport> {
	return await commands.testAutomation(ruleId);
}
