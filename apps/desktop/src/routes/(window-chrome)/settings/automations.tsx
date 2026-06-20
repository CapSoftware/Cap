import { Button } from "@cap/ui-solid";
import { CheckMenuItem, Menu } from "@tauri-apps/api/menu";
import { open } from "@tauri-apps/plugin-dialog";
import { cx } from "cva";
import {
	type Component,
	createResource,
	createSignal,
	For,
	type JSX,
	Show,
	Suspense,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Dynamic } from "solid-js/web";
import toast from "solid-toast";
import { Toggle } from "~/components/Toggle";
import { presetsStore } from "~/store";
import {
	ACTION_LABELS,
	type Action,
	type ActionType,
	type AutomationRecordingMode,
	type AutomationRule,
	type AutomationsStore,
	type AutomationTestReport,
	actionAppliesToTrigger,
	type CaptureTargetKind,
	type ClipboardSource,
	CONDITION_LABELS,
	type Condition,
	conditionAppliesToTrigger,
	createEmptyRule,
	DANGEROUS_ACTIONS,
	defaultActionForType,
	defaultConditionForType,
	type ExportCompression,
	type ExportFormat,
	getAutomations,
	type MatchMode,
	setAutomations,
	TRIGGER_LABELS,
	type Trigger,
	testAutomation,
} from "~/utils/automations";
import IconLucideBell from "~icons/lucide/bell";
import IconLucideChevronDown from "~icons/lucide/chevron-down";
import IconLucideChevronUp from "~icons/lucide/chevron-up";
import IconLucideCirclePlay from "~icons/lucide/circle-play";
import IconLucideClapperboard from "~icons/lucide/clapperboard";
import IconLucideCloudUpload from "~icons/lucide/cloud-upload";
import IconLucideCopy from "~icons/lucide/copy";
import IconLucideFilm from "~icons/lucide/film";
import IconLucideFolderDown from "~icons/lucide/folder-down";
import IconLucideFolderOpen from "~icons/lucide/folder-open";
import IconLucideImage from "~icons/lucide/image";
import IconLucideImport from "~icons/lucide/import";
import IconLucideLink from "~icons/lucide/link";
import IconLucidePlus from "~icons/lucide/plus";
import IconLucideScanText from "~icons/lucide/scan-text";
import IconLucideTrash2 from "~icons/lucide/trash-2";
import IconLucideWebhook from "~icons/lucide/webhook";
import IconLucideX from "~icons/lucide/x";
import IconLucideZap from "~icons/lucide/zap";
import { Section, SectionCard, SettingsPageContent } from "./Setting";

const ALL_TRIGGERS: Trigger[] = [
	"screenshotTaken",
	"studioRecordingFinished",
	"instantRecordingFinished",
	"recordingStarted",
	"uploadCompleted",
	"videoImported",
	"recordingDeleted",
];

const ALL_ACTION_TYPES: ActionType[] = [
	"copyToClipboard",
	"saveToLocation",
	"export",
	"upload",
	"revealInFileManager",
	"openFile",
	"recognizeTextToClipboard",
	"notify",
	"openEditor",
	"skipEditor",
	"applyPreset",
	"runCommand",
	"webhook",
	"deleteLocalFiles",
];

const ALL_CONDITION_TYPES: Condition["type"][] = [
	"captureTargetIs",
	"recordingModeIs",
	"durationAtLeast",
	"durationAtMost",
	"windowTitleContains",
	"organizationIs",
];

type IconComponent = Component<{ class?: string }>;

const TRIGGER_ICONS: Record<Trigger, IconComponent> = {
	screenshotTaken: IconLucideImage,
	studioRecordingFinished: IconLucideClapperboard,
	instantRecordingFinished: IconLucideZap,
	recordingStarted: IconLucideCirclePlay,
	uploadCompleted: IconLucideCloudUpload,
	videoImported: IconLucideImport,
	recordingDeleted: IconLucideTrash2,
};

const TRIGGER_PHRASE: Record<Trigger, string> = {
	screenshotTaken: "Screenshot taken",
	studioRecordingFinished: "Studio recording ends",
	instantRecordingFinished: "Instant recording ends",
	recordingStarted: "Recording starts",
	uploadCompleted: "Upload completes",
	videoImported: "Video imported",
	recordingDeleted: "Recording deleted",
};

const ACTION_SHORT: Record<ActionType, string> = {
	copyToClipboard: "Copy to clipboard",
	saveToLocation: "Save to folder",
	export: "Export",
	upload: "Upload & copy link",
	revealInFileManager: "Reveal in file manager",
	openFile: "Open file",
	recognizeTextToClipboard: "Copy text (OCR)",
	notify: "Notify",
	openEditor: "Open editor",
	skipEditor: "Skip editor",
	applyPreset: "Apply preset",
	runCommand: "Run command",
	webhook: "Send webhook",
	deleteLocalFiles: "Delete local files",
};

const TRIGGER_NOUN: Record<Trigger, string> = {
	screenshotTaken: "Screenshot",
	studioRecordingFinished: "Studio recording",
	instantRecordingFinished: "Instant recording",
	recordingStarted: "Recording start",
	uploadCompleted: "Upload",
	videoImported: "Import",
	recordingDeleted: "Deletion",
};

const ACTION_NOUN: Record<ActionType, string> = {
	copyToClipboard: "Clipboard",
	saveToLocation: "Folder",
	export: "Export",
	upload: "Upload",
	revealInFileManager: "Reveal",
	openFile: "Open",
	recognizeTextToClipboard: "Text",
	notify: "Notify",
	openEditor: "Editor",
	skipEditor: "Skip editor",
	applyPreset: "Preset",
	runCommand: "Command",
	webhook: "Webhook",
	deleteLocalFiles: "Delete",
};

const FPS_PRESETS = [15, 30, 60] as const;

const RESOLUTION_PRESETS = [
	{ label: "720p", value: "720p", x: 1280, y: 720 },
	{ label: "1080p", value: "1080p", x: 1920, y: 1080 },
	{ label: "1440p", value: "1440p", x: 2560, y: 1440 },
	{ label: "4K", value: "4k", x: 3840, y: 2160 },
] as const;

type Template = {
	id: string;
	name: string;
	description: string;
	icon: IconComponent;
	build: () => AutomationRule;
};

function buildRule(opts: {
	name: string;
	trigger: Trigger;
	actions: Action[];
	conditions?: Condition[];
	matchMode?: MatchMode;
}): AutomationRule {
	return {
		id: crypto.randomUUID(),
		name: opts.name,
		enabled: true,
		trigger: opts.trigger,
		matchMode: opts.matchMode ?? "all",
		conditions: opts.conditions ?? [],
		actions: opts.actions,
	};
}

const TEMPLATES: Template[] = [
	{
		id: "copy-screenshot",
		name: "Auto-copy new screenshots to clipboard",
		description: "Snap a screenshot and it's right there, ready to paste.",
		icon: IconLucideCopy,
		build: () =>
			buildRule({
				name: "Auto-copy new screenshots to clipboard",
				trigger: "screenshotTaken",
				actions: [{ type: "copyToClipboard", source: "raw" }],
			}),
	},
	{
		id: "ocr-screenshot",
		name: "Pull the text out of screenshots",
		description: "Cap reads the text in your screenshot and copies it for you.",
		icon: IconLucideScanText,
		build: () =>
			buildRule({
				name: "Pull the text out of screenshots",
				trigger: "screenshotTaken",
				actions: [{ type: "recognizeTextToClipboard" }],
			}),
	},
	{
		id: "save-screenshot",
		name: "Tuck screenshots into a folder",
		description: "Send every new screenshot straight to a folder you pick.",
		icon: IconLucideFolderDown,
		build: () =>
			buildRule({
				name: "Tuck screenshots into a folder",
				trigger: "screenshotTaken",
				actions: [defaultActionForType("saveToLocation")],
			}),
	},
	{
		id: "reveal-screenshot",
		name: "Jump to each new screenshot",
		description: "Pop open every screenshot in Finder the moment you take it.",
		icon: IconLucideFolderOpen,
		build: () =>
			buildRule({
				name: "Jump to each new screenshot",
				trigger: "screenshotTaken",
				actions: [{ type: "revealInFileManager" }],
			}),
	},
	{
		id: "export-studio",
		name: "Auto-export when you finish recording",
		description: "Render an MP4 the second a Studio recording wraps up.",
		icon: IconLucideFilm,
		build: () =>
			buildRule({
				name: "Auto-export when you finish recording",
				trigger: "studioRecordingFinished",
				actions: [defaultActionForType("export")],
			}),
	},
	{
		id: "upload-share",
		name: "Upload and grab the share link",
		description:
			"Finish a recording and the link is waiting on your clipboard.",
		icon: IconLucideLink,
		build: () =>
			buildRule({
				name: "Upload and grab the share link",
				trigger: "studioRecordingFinished",
				actions: [defaultActionForType("upload")],
			}),
	},
	{
		id: "notify-upload",
		name: "Ping me when an upload is ready",
		description: "Get a gentle desktop nudge once your recording is shareable.",
		icon: IconLucideBell,
		build: () =>
			buildRule({
				name: "Ping me when an upload is ready",
				trigger: "uploadCompleted",
				actions: [
					{
						type: "notify",
						titleTemplate: "Cap",
						bodyTemplate: "Your recording is ready to share.",
					},
				],
			}),
	},
	{
		id: "webhook-share",
		name: "Tell Slack when you share something",
		description: "Send the share link to Slack, Discord, or your own webhook.",
		icon: IconLucideWebhook,
		build: () =>
			buildRule({
				name: "Tell Slack when you share something",
				trigger: "instantRecordingFinished",
				actions: [
					{
						type: "webhook",
						url: "",
						method: "POST",
						headers: {},
						bodyTemplate: '{"text":"{share_link}"}',
					},
				],
			}),
	},
];

function ruleSummary(rule: AutomationRule): string {
	const trigger = TRIGGER_PHRASE[rule.trigger];
	if (rule.actions.length === 0) return `${trigger} → no actions yet`;
	const actions = rule.actions.map((a) => ACTION_SHORT[a.type]).join(", ");
	return `${trigger} → ${actions}`;
}

function autoRuleName(rule: AutomationRule): string {
	const trigger = TRIGGER_NOUN[rule.trigger];
	const first = rule.actions[0];
	if (!first) return `${trigger} automation`;
	return `${trigger} → ${ACTION_NOUN[first.type]}`;
}

function ruleDisplayName(rule: AutomationRule): string {
	return rule.name.trim() || autoRuleName(rule);
}

const inputClass =
	"w-full px-2.5 h-8 text-[13px] rounded-lg bg-gray-1 border border-gray-3 text-gray-12 outline-none transition-colors focus:border-gray-6 placeholder:text-gray-9";

function TextInput(props: {
	value: string;
	placeholder?: string;
	onInput: (v: string) => void;
}) {
	return (
		<input
			type="text"
			class={inputClass}
			value={props.value}
			placeholder={props.placeholder}
			onInput={(e) => props.onInput(e.currentTarget.value)}
		/>
	);
}

function NumberInput(props: { value: number; onInput: (v: number) => void }) {
	return (
		<input
			type="number"
			class={cx(inputClass, "w-28")}
			value={props.value}
			onInput={(e) => props.onInput(Number(e.currentTarget.value) || 0)}
		/>
	);
}

function SelectInput<T extends string>(props: {
	value: T;
	options: { value: T; label: string }[];
	onChange: (v: T) => void;
	class?: string;
}) {
	const current = () => props.options.find((o) => o.value === props.value);

	const openMenu = async () => {
		const items = await Promise.all(
			props.options.map((option) =>
				CheckMenuItem.new({
					text: option.label,
					checked: option.value === props.value,
					action: () => props.onChange(option.value),
				}),
			),
		);
		const menu = await Menu.new({ items });
		await menu.popup();
		await menu.close();
	};

	return (
		<button
			type="button"
			onClick={() => void openMenu()}
			class={cx(
				"flex gap-2 justify-between items-center w-full px-2.5 h-8 text-[13px] rounded-lg border transition-colors cursor-pointer bg-gray-1 border-gray-3 text-gray-12 outline-none hover:bg-gray-2 hover:border-gray-5 focus-visible:border-gray-6",
				props.class,
			)}
		>
			<span class="truncate">{current()?.label ?? props.value}</span>
			<IconLucideChevronDown class="size-3.5 shrink-0 text-gray-10" />
		</button>
	);
}

function Field(props: { label: string; children: JSX.Element }) {
	return (
		<label class="flex flex-col gap-1 min-w-0 flex-1">
			<span class="text-[11px] font-medium text-gray-10">{props.label}</span>
			{props.children}
		</label>
	);
}

function GroupLabel(props: { children: JSX.Element }) {
	return (
		<span class="text-[11px] font-medium uppercase tracking-wide text-gray-9">
			{props.children}
		</span>
	);
}

function RowButton(props: {
	onClick: () => void;
	title: string;
	children: JSX.Element;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			title={props.title}
			disabled={props.disabled}
			onClick={props.onClick}
			class="flex items-center justify-center size-7 rounded-lg text-gray-10 hover:text-gray-12 hover:bg-gray-3 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
		>
			{props.children}
		</button>
	);
}

export default function AutomationsSettings() {
	const [store, setStore] = createStore<AutomationsStore>({
		version: 1,
		rules: [],
	});
	const [loaded, setLoaded] = createSignal(false);
	const [expandedId, setExpandedId] = createSignal<string | null>(null);
	const [testReports, setTestReports] = createStore<
		Record<string, AutomationTestReport>
	>({});

	const [initial] = createResource(async () => {
		const data = await getAutomations();
		setStore({
			version: data.version ?? 1,
			rules: data.rules ?? [],
		});
		setLoaded(true);
		return data;
	});

	const persist = async () => {
		try {
			await setAutomations({
				version: store.version,
				rules: store.rules,
			});
		} catch (e) {
			console.error("Failed to save automations", e);
			toast.error("Failed to save automations");
		}
	};

	const mutate = (fn: (s: AutomationsStore) => void) => {
		setStore(produce(fn));
		void persist();
	};

	const addRule = (rule: AutomationRule) => {
		mutate((s) => {
			s.rules.push(rule);
		});
		setExpandedId(rule.id);
	};

	const addFromTemplate = (template: Template) => {
		addRule(template.build());
		toast.success(`Added "${template.name}"`);
	};

	const removeRule = (id: string) => {
		mutate((s) => {
			const index = s.rules.findIndex((r) => r.id === id);
			if (index >= 0) s.rules.splice(index, 1);
		});
		if (expandedId() === id) setExpandedId(null);
	};

	const runTest = async (ruleId: string) => {
		try {
			const report = await testAutomation(ruleId);
			setTestReports(ruleId, report);
			const unsupported = report.actionChecks.filter((c) => !c.supported);
			if (unsupported.length === 0) {
				toast.success("All actions supported on this device");
			} else {
				toast(
					`${unsupported.length} action(s) not supported here: ${unsupported
						.map((c) => c.actionType)
						.join(", ")}`,
				);
			}
		} catch (e) {
			console.error("Failed to test automation", e);
			toast.error("Failed to test automation");
		}
	};

	return (
		<div class="cap-settings-page flex flex-col h-full custom-scroll">
			<SettingsPageContent>
				<Section
					title="Automations"
					description="Run actions automatically when something happens in Cap. Rules are shared with the Cap CLI."
				>
					<Suspense
						fallback={<div class="h-24 rounded-xl bg-gray-3 animate-pulse" />}
					>
						<Show when={loaded() || initial()}>
							<Show
								when={store.rules.length > 0}
								fallback={
									<EmptyState onCreate={() => addRule(createEmptyRule())} />
								}
							>
								<div class="space-y-2.5">
									<For each={store.rules}>
										{(rule, index) => (
											<RuleCard
												rule={rule}
												report={testReports[rule.id]}
												expanded={expandedId() === rule.id}
												onToggleExpand={() =>
													setExpandedId((id) =>
														id === rule.id ? null : rule.id,
													)
												}
												onTest={() => runTest(rule.id)}
												onRemove={() => removeRule(rule.id)}
												onChange={(fn) => mutate((s) => fn(s.rules[index()]))}
											/>
										)}
									</For>
									<AddRuleButton onClick={() => addRule(createEmptyRule())} />
								</div>
							</Show>
						</Show>
					</Suspense>
				</Section>

				<Section
					title="Templates"
					description="One click to add a ready-made automation. Tweak anything afterwards."
				>
					<div class="grid grid-cols-2 gap-2.5">
						<For each={TEMPLATES}>
							{(template) => (
								<TemplateCard
									template={template}
									onAdd={() => addFromTemplate(template)}
								/>
							)}
						</For>
					</div>
				</Section>
			</SettingsPageContent>
		</div>
	);
}

function EmptyState(props: { onCreate: () => void }) {
	return (
		<SectionCard padded>
			<div class="flex flex-col gap-2 items-center py-6 text-center">
				<div class="flex justify-center items-center mb-1 rounded-full size-11 bg-gray-3 text-gray-10">
					<IconLucideZap class="size-5" />
				</div>
				<p class="text-[13px] font-medium text-gray-12">No automations yet</p>
				<p class="max-w-xs text-xs leading-relaxed text-gray-10">
					Pick a template below to get started in one click, or build your own
					from scratch.
				</p>
				<Button
					variant="gray"
					size="sm"
					onClick={props.onCreate}
					class="flex gap-1.5 items-center mt-1"
				>
					<IconLucidePlus class="size-3.5" />
					Start from scratch
				</Button>
			</div>
		</SectionCard>
	);
}

function AddRuleButton(props: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={props.onClick}
			class="flex gap-1.5 justify-center items-center py-2.5 w-full text-[13px] rounded-xl border border-dashed transition-colors border-gray-4 text-gray-10 hover:text-gray-12 hover:border-gray-6 hover:bg-gray-2"
		>
			<IconLucidePlus class="size-4" />
			New automation
		</button>
	);
}

function TemplateCard(props: { template: Template; onAdd: () => void }) {
	return (
		<button
			type="button"
			onClick={props.onAdd}
			class="flex gap-3 items-start p-3 text-left rounded-xl border transition-colors group border-gray-3 bg-gray-2 hover:bg-gray-3 hover:border-gray-5"
		>
			<div class="flex justify-center items-center rounded-lg transition-colors size-9 shrink-0 bg-gray-3 text-gray-11 group-hover:bg-gray-4 group-hover:text-gray-12">
				<Dynamic component={props.template.icon} class="size-[18px]" />
			</div>
			<div class="flex-1 min-w-0">
				<p class="text-[13px] font-medium text-gray-12">
					{props.template.name}
				</p>
				<p class="mt-0.5 text-[11px] leading-snug text-gray-10">
					{props.template.description}
				</p>
			</div>
		</button>
	);
}

function RuleCard(props: {
	rule: AutomationRule;
	report?: AutomationTestReport;
	expanded: boolean;
	onToggleExpand: () => void;
	onChange: (fn: (rule: AutomationRule) => void) => void;
	onRemove: () => void;
	onTest: () => void;
}) {
	return (
		<SectionCard class="overflow-hidden">
			<div class="flex gap-3 items-center p-2.5">
				<div
					class={cx(
						"flex justify-center items-center rounded-lg size-9 shrink-0 bg-gray-3 transition-opacity",
						props.rule.enabled ? "text-gray-11" : "text-gray-9 opacity-60",
					)}
				>
					<Dynamic
						component={TRIGGER_ICONS[props.rule.trigger]}
						class="size-[18px]"
					/>
				</div>
				<button
					type="button"
					onClick={props.onToggleExpand}
					class="flex-1 min-w-0 text-left"
				>
					<p
						class={cx(
							"text-[13px] font-medium truncate",
							props.rule.enabled ? "text-gray-12" : "text-gray-10",
						)}
					>
						{ruleDisplayName(props.rule)}
					</p>
					<Show when={props.rule.name.trim()}>
						<p class="text-[11px] truncate text-gray-10">
							{ruleSummary(props.rule)}
						</p>
					</Show>
				</button>
				<Toggle
					size="sm"
					checked={props.rule.enabled}
					onChange={(v) =>
						props.onChange((r) => {
							r.enabled = v;
						})
					}
				/>
				<button
					type="button"
					onClick={props.onToggleExpand}
					title={props.expanded ? "Collapse" : "Edit"}
					class="flex justify-center items-center rounded-lg transition-colors size-7 text-gray-10 hover:text-gray-12 hover:bg-gray-3"
				>
					<IconLucideChevronDown
						class={cx(
							"size-4 transition-transform duration-200",
							props.expanded && "rotate-180",
						)}
					/>
				</button>
			</div>

			<Show when={props.expanded}>
				<div class="border-t border-gray-3 animate-in fade-in slide-in-from-top-1 duration-150">
					<RuleEditorBody
						rule={props.rule}
						report={props.report}
						onChange={props.onChange}
						onRemove={props.onRemove}
						onTest={props.onTest}
					/>
				</div>
			</Show>
		</SectionCard>
	);
}

function RuleEditorBody(props: {
	rule: AutomationRule;
	report?: AutomationTestReport;
	onChange: (fn: (rule: AutomationRule) => void) => void;
	onRemove: () => void;
	onTest: () => void;
}) {
	const hasDangerous = () =>
		props.rule.actions.some((a) => DANGEROUS_ACTIONS.includes(a.type));

	const addCondition = () =>
		props.onChange((r) => {
			const type =
				ALL_CONDITION_TYPES.find((t) =>
					conditionAppliesToTrigger(t, r.trigger),
				) ?? "captureTargetIs";
			r.conditions.push(defaultConditionForType(type));
		});

	const addAction = () =>
		props.onChange((r) => {
			const type = actionAppliesToTrigger("copyToClipboard", r.trigger)
				? "copyToClipboard"
				: (ALL_ACTION_TYPES.find((t) => actionAppliesToTrigger(t, r.trigger)) ??
					"notify");
			r.actions.push(defaultActionForType(type));
		});

	return (
		<div class="p-4 space-y-5">
			<Field label="Name">
				<TextInput
					value={props.rule.name}
					placeholder={autoRuleName(props.rule)}
					onInput={(v) =>
						props.onChange((r) => {
							r.name = v;
						})
					}
				/>
			</Field>

			<div class="space-y-1.5">
				<GroupLabel>When this happens</GroupLabel>
				<SelectInput<Trigger>
					value={props.rule.trigger}
					options={ALL_TRIGGERS.map((t) => ({
						value: t,
						label: TRIGGER_LABELS[t],
					}))}
					onChange={(v) =>
						props.onChange((r) => {
							r.trigger = v;
						})
					}
				/>
			</div>

			<div class="space-y-2">
				<div class="flex justify-between items-center">
					<GroupLabel>Only run if</GroupLabel>
					<div class="flex gap-2 items-center">
						<Show when={props.rule.conditions.length > 1}>
							<SelectInput<MatchMode>
								class="w-28"
								value={props.rule.matchMode}
								options={[
									{ value: "all", label: "Match all" },
									{ value: "any", label: "Match any" },
								]}
								onChange={(v) =>
									props.onChange((r) => {
										r.matchMode = v;
									})
								}
							/>
						</Show>
						<Button variant="gray" size="xs" onClick={addCondition}>
							Add condition
						</Button>
					</div>
				</div>
				<Show
					when={props.rule.conditions.length > 0}
					fallback={
						<p class="text-xs text-gray-9">
							Runs for every {TRIGGER_PHRASE[props.rule.trigger].toLowerCase()}.
						</p>
					}
				>
					<div class="space-y-2">
						<For each={props.rule.conditions}>
							{(condition, ci) => (
								<ConditionRow
									condition={condition}
									trigger={props.rule.trigger}
									onChange={(fn) =>
										props.onChange((r) => fn(r.conditions[ci()]))
									}
									onReplace={(next) =>
										props.onChange((r) => {
											r.conditions[ci()] = next;
										})
									}
									onRemove={() =>
										props.onChange((r) => {
											r.conditions.splice(ci(), 1);
										})
									}
								/>
							)}
						</For>
					</div>
				</Show>
			</div>

			<div class="space-y-2">
				<div class="flex justify-between items-center">
					<GroupLabel>Then do this</GroupLabel>
					<Button variant="gray" size="xs" onClick={addAction}>
						Add action
					</Button>
				</div>
				<div class="space-y-2">
					<For each={props.rule.actions}>
						{(action, ai) => (
							<ActionRow
								action={action}
								trigger={props.rule.trigger}
								isFirst={ai() === 0}
								isLast={ai() === props.rule.actions.length - 1}
								support={props.report?.actionChecks[ai()]?.supported}
								onChange={(fn) => props.onChange((r) => fn(r.actions[ai()]))}
								onReplace={(next) =>
									props.onChange((r) => {
										r.actions[ai()] = next;
									})
								}
								onRemove={() =>
									props.onChange((r) => {
										r.actions.splice(ai(), 1);
									})
								}
								onMove={(dir) =>
									props.onChange((r) => {
										const to = ai() + dir;
										if (to < 0 || to >= r.actions.length) return;
										const [moved] = r.actions.splice(ai(), 1);
										r.actions.splice(to, 0, moved);
									})
								}
							/>
						)}
					</For>
				</div>
			</div>

			<Show when={hasDangerous()}>
				<p class="text-xs leading-relaxed text-amber-600 dark:text-amber-500">
					This automation runs commands or sends network requests. Only use
					values you trust — they execute automatically with your permissions.
				</p>
			</Show>

			<div class="flex justify-between items-center pt-4 border-t border-gray-3 -mx-4 px-4 -mb-4 pb-4 mt-2">
				<span title="Checks which actions are supported on this device. Does not run the automation.">
					<Button variant="gray" size="xs" onClick={props.onTest}>
						Check compatibility
					</Button>
				</span>
				<button
					type="button"
					onClick={props.onRemove}
					class="flex gap-1.5 items-center px-2 h-6 text-[0.75rem] rounded-lg transition-colors text-gray-10 hover:text-red-500 hover:bg-red-500/10"
				>
					<IconLucideTrash2 class="size-3.5" />
					Delete
				</button>
			</div>
		</div>
	);
}

function ConditionRow(props: {
	condition: Condition;
	trigger: Trigger;
	onChange: (fn: (condition: Condition) => void) => void;
	onReplace: (next: Condition) => void;
	onRemove: () => void;
}) {
	const applies = () =>
		conditionAppliesToTrigger(props.condition.type, props.trigger);
	return (
		<div class="space-y-1">
			<div class="flex gap-2 items-start p-2.5 rounded-lg border border-gray-3 bg-gray-1">
				<div class="grid flex-1 grid-cols-2 gap-2 min-w-0">
					<SelectInput<Condition["type"]>
						value={props.condition.type}
						options={ALL_CONDITION_TYPES.map((t) => ({
							value: t,
							label: CONDITION_LABELS[t],
						}))}
						onChange={(t) => props.onReplace(defaultConditionForType(t))}
					/>
					<ConditionValue
						condition={props.condition}
						onChange={props.onChange}
					/>
				</div>
				<RowButton onClick={props.onRemove} title="Remove condition">
					<IconLucideX class="size-4" />
				</RowButton>
			</div>
			<Show when={!applies()}>
				<p class="px-1 text-[11px] text-amber-600 dark:text-amber-500">
					This condition never matches for the selected trigger.
				</p>
			</Show>
		</div>
	);
}

function ConditionValue(props: {
	condition: Condition;
	onChange: (fn: (condition: Condition) => void) => void;
}) {
	const c = props.condition;
	switch (c.type) {
		case "captureTargetIs":
			return (
				<SelectInput<CaptureTargetKind>
					value={c.target}
					options={[
						{ value: "display", label: "Display" },
						{ value: "window", label: "Window" },
						{ value: "area", label: "Area" },
					]}
					onChange={(v) =>
						props.onChange((cond) => {
							if (cond.type === "captureTargetIs") cond.target = v;
						})
					}
				/>
			);
		case "recordingModeIs":
			return (
				<SelectInput<AutomationRecordingMode>
					value={c.mode}
					options={[
						{ value: "studio", label: "Studio" },
						{ value: "instant", label: "Instant" },
					]}
					onChange={(v) =>
						props.onChange((cond) => {
							if (cond.type === "recordingModeIs") cond.mode = v;
						})
					}
				/>
			);
		case "durationAtLeast":
		case "durationAtMost":
			return (
				<NumberInput
					value={c.secs}
					onInput={(v) =>
						props.onChange((cond) => {
							if (
								cond.type === "durationAtLeast" ||
								cond.type === "durationAtMost"
							)
								cond.secs = v;
						})
					}
				/>
			);
		case "windowTitleContains":
			return (
				<TextInput
					value={c.pattern}
					placeholder="e.g. Slack"
					onInput={(v) =>
						props.onChange((cond) => {
							if (cond.type === "windowTitleContains") cond.pattern = v;
						})
					}
				/>
			);
		case "organizationIs":
			return (
				<TextInput
					value={c.id}
					placeholder="Organization ID"
					onInput={(v) =>
						props.onChange((cond) => {
							if (cond.type === "organizationIs") cond.id = v;
						})
					}
				/>
			);
	}
}

function ActionRow(props: {
	action: Action;
	trigger: Trigger;
	isFirst: boolean;
	isLast: boolean;
	support?: boolean;
	onChange: (fn: (action: Action) => void) => void;
	onReplace: (next: Action) => void;
	onRemove: () => void;
	onMove: (dir: -1 | 1) => void;
}) {
	const applies = () =>
		actionAppliesToTrigger(props.action.type, props.trigger);
	return (
		<div class="p-3 space-y-3 rounded-lg border border-gray-3 bg-gray-1">
			<div class="flex gap-2 items-center">
				<SelectInput<ActionType>
					class="flex-1"
					value={props.action.type}
					options={ALL_ACTION_TYPES.map((t) => ({
						value: t,
						label: ACTION_LABELS[t],
					}))}
					onChange={(t) => props.onReplace(defaultActionForType(t))}
				/>
				<Show when={props.support === false}>
					<span
						title="Not supported on this device; will be skipped"
						class="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-500"
					>
						Skipped here
					</span>
				</Show>
				<RowButton
					onClick={() => props.onMove(-1)}
					title="Move up"
					disabled={props.isFirst}
				>
					<IconLucideChevronUp class="size-4" />
				</RowButton>
				<RowButton
					onClick={() => props.onMove(1)}
					title="Move down"
					disabled={props.isLast}
				>
					<IconLucideChevronDown class="size-4" />
				</RowButton>
				<RowButton onClick={props.onRemove} title="Remove action">
					<IconLucideX class="size-4" />
				</RowButton>
			</div>
			<ActionParams action={props.action} onChange={props.onChange} />
			<Show when={!applies()}>
				<p class="text-[11px] text-amber-600 dark:text-amber-500">
					This action has no effect for the selected trigger.
				</p>
			</Show>
		</div>
	);
}

function ActionParams(props: {
	action: Action;
	onChange: (fn: (action: Action) => void) => void;
}) {
	const a = props.action;
	switch (a.type) {
		case "copyToClipboard":
			return (
				<Field label="Source">
					<SelectInput<ClipboardSource>
						value={a.source}
						options={[
							{ value: "raw", label: "Original capture" },
							{ value: "rendered", label: "Edited / rendered" },
						]}
						onChange={(v) =>
							props.onChange((act) => {
								if (act.type === "copyToClipboard") act.source = v;
							})
						}
					/>
				</Field>
			);
		case "saveToLocation":
			return (
				<div class="flex gap-2">
					<Field label="Folder">
						<div class="flex gap-2">
							<TextInput
								value={a.dir}
								placeholder="/Users/you/Screenshots"
								onInput={(v) =>
									props.onChange((act) => {
										if (act.type === "saveToLocation") act.dir = v;
									})
								}
							/>
							<Button
								variant="gray"
								size="sm"
								onClick={async () => {
									const dir = await open({ directory: true });
									if (typeof dir === "string")
										props.onChange((act) => {
											if (act.type === "saveToLocation") act.dir = dir;
										});
								}}
							>
								Browse
							</Button>
						</div>
					</Field>
					<Field label="Filename template (optional)">
						<TextInput
							value={a.filenameTemplate ?? ""}
							placeholder="{date}-{window}"
							onInput={(v) =>
								props.onChange((act) => {
									if (act.type === "saveToLocation")
										act.filenameTemplate = v.length > 0 ? v : null;
								})
							}
						/>
					</Field>
				</div>
			);
		case "export":
			return <ExportParams action={a} onChange={props.onChange} />;
		case "upload":
			return (
				<div class="space-y-2">
					<Field label="Organization ID (optional)">
						<TextInput
							value={a.organizationId ?? ""}
							onInput={(v) =>
								props.onChange((act) => {
									if (act.type === "upload")
										act.organizationId = v.length > 0 ? v : null;
								})
							}
						/>
					</Field>
					<div class="flex gap-6">
						<label class="flex gap-2 items-center text-[13px] text-gray-12">
							<Toggle
								size="sm"
								checked={a.copyLink}
								onChange={(v) =>
									props.onChange((act) => {
										if (act.type === "upload") act.copyLink = v;
									})
								}
							/>
							Copy link to clipboard
						</label>
						<label class="flex gap-2 items-center text-[13px] text-gray-12">
							<Toggle
								size="sm"
								checked={a.openInBrowser}
								onChange={(v) =>
									props.onChange((act) => {
										if (act.type === "upload") act.openInBrowser = v;
									})
								}
							/>
							Open in browser
						</label>
					</div>
				</div>
			);
		case "runCommand":
			return (
				<div class="space-y-2">
					<div class="flex gap-2">
						<Field label="Program">
							<TextInput
								value={a.program}
								placeholder="/usr/local/bin/my-script"
								onInput={(v) =>
									props.onChange((act) => {
										if (act.type === "runCommand") act.program = v;
									})
								}
							/>
						</Field>
						<Field label="Arguments (space-separated)">
							<TextInput
								value={a.args.join(" ")}
								onInput={(v) =>
									props.onChange((act) => {
										if (act.type === "runCommand")
											act.args = v.length > 0 ? v.split(" ") : [];
									})
								}
							/>
						</Field>
					</div>
					<label class="flex gap-2 items-center text-[13px] text-gray-12">
						<Toggle
							size="sm"
							checked={a.useShell}
							onChange={(v) =>
								props.onChange((act) => {
									if (act.type === "runCommand") act.useShell = v;
								})
							}
						/>
						Run through shell
					</label>
				</div>
			);
		case "webhook":
			return (
				<div class="space-y-2">
					<div class="flex gap-2">
						<Field label="URL">
							<TextInput
								value={a.url}
								placeholder="https://hooks.slack.com/..."
								onInput={(v) =>
									props.onChange((act) => {
										if (act.type === "webhook") act.url = v;
									})
								}
							/>
						</Field>
						<Field label="Method">
							<SelectInput<string>
								class="w-28"
								value={a.method}
								options={[
									{ value: "POST", label: "POST" },
									{ value: "PUT", label: "PUT" },
									{ value: "GET", label: "GET" },
								]}
								onChange={(v) =>
									props.onChange((act) => {
										if (act.type === "webhook") act.method = v;
									})
								}
							/>
						</Field>
					</div>
					<Field label="Body template (optional)">
						<TextInput
							value={a.bodyTemplate ?? ""}
							placeholder='{"text":"{share_link}"}'
							onInput={(v) =>
								props.onChange((act) => {
									if (act.type === "webhook")
										act.bodyTemplate = v.length > 0 ? v : null;
								})
							}
						/>
					</Field>
				</div>
			);
		case "notify":
			return (
				<div class="flex gap-2">
					<Field label="Title">
						<TextInput
							value={a.titleTemplate}
							onInput={(v) =>
								props.onChange((act) => {
									if (act.type === "notify") act.titleTemplate = v;
								})
							}
						/>
					</Field>
					<Field label="Body">
						<TextInput
							value={a.bodyTemplate}
							onInput={(v) =>
								props.onChange((act) => {
									if (act.type === "notify") act.bodyTemplate = v;
								})
							}
						/>
					</Field>
				</div>
			);
		case "applyPreset":
			return (
				<Field label="Preset">
					<PresetSelect
						value={a.name}
						onChange={(name) =>
							props.onChange((act) => {
								if (act.type === "applyPreset") act.name = name;
							})
						}
					/>
				</Field>
			);
		default:
			return null;
	}
}

function PresetSelect(props: {
	value: string;
	allowNone?: boolean;
	onChange: (name: string) => void;
}) {
	const presets = presetsStore.createQuery();
	const names = () => presets.data?.presets.map((p) => p.name) ?? [];
	const options = () => [
		...(props.allowNone ? [{ value: "", label: "None" }] : []),
		...names().map((n) => ({ value: n, label: n })),
	];

	return (
		<Show
			when={props.allowNone || names().length > 0}
			fallback={
				<p class="px-0.5 py-1.5 text-[11px] text-gray-9">
					No presets yet — create one in the editor first.
				</p>
			}
		>
			<SelectInput
				value={props.value}
				options={options()}
				onChange={props.onChange}
			/>
		</Show>
	);
}

function ExportParams(props: {
	action: Extract<Action, { type: "export" }>;
	onChange: (fn: (action: Action) => void) => void;
}) {
	const a = props.action;
	const updateProfile = (fn: (p: typeof a.profile) => void) =>
		props.onChange((act) => {
			if (act.type === "export") fn(act.profile);
		});

	const resolutionValue = () =>
		RESOLUTION_PRESETS.find(
			(r) =>
				r.x === a.profile.resolutionBase.x &&
				r.y === a.profile.resolutionBase.y,
		)?.value ?? "1080p";

	return (
		<div class="space-y-2">
			<div class="flex gap-2">
				<Field label="Format">
					<SelectInput<ExportFormat>
						value={a.profile.format}
						options={[
							{ value: "mp4", label: "MP4" },
							{ value: "gif", label: "GIF" },
							{ value: "mov", label: "MOV" },
						]}
						onChange={(v) =>
							updateProfile((p) => {
								p.format = v;
							})
						}
					/>
				</Field>
				<Field label="Resolution">
					<SelectInput
						value={resolutionValue()}
						options={RESOLUTION_PRESETS.map((r) => ({
							value: r.value,
							label: r.label,
						}))}
						onChange={(v) => {
							const preset = RESOLUTION_PRESETS.find((r) => r.value === v);
							if (preset)
								updateProfile((p) => {
									p.resolutionBase = { x: preset.x, y: preset.y };
								});
						}}
					/>
				</Field>
			</div>
			<div class="flex gap-2">
				<Field label="Frame rate">
					<SelectInput
						value={String(a.profile.fps)}
						options={FPS_PRESETS.map((f) => ({
							value: String(f),
							label: `${f} FPS`,
						}))}
						onChange={(v) =>
							updateProfile((p) => {
								p.fps = Number(v);
							})
						}
					/>
				</Field>
				<Show when={a.profile.format === "mp4"}>
					<Field label="Compression">
						<SelectInput<ExportCompression>
							value={a.profile.compression ?? "web"}
							options={[
								{ value: "maximum", label: "Maximum" },
								{ value: "social", label: "Social" },
								{ value: "web", label: "Web" },
								{ value: "potato", label: "Potato" },
							]}
							onChange={(v) =>
								updateProfile((p) => {
									p.compression = v;
								})
							}
						/>
					</Field>
				</Show>
			</div>
			<Field label="Destination folder (optional, blank = project folder)">
				<div class="flex gap-2">
					<TextInput
						value={
							a.destination === "projectFolder"
								? ""
								: a.destination.customPath.dir
						}
						placeholder="Project folder"
						onInput={(v) =>
							props.onChange((act) => {
								if (act.type === "export")
									act.destination =
										v.length > 0 ? { customPath: { dir: v } } : "projectFolder";
							})
						}
					/>
					<Button
						variant="gray"
						size="sm"
						onClick={async () => {
							const dir = await open({ directory: true });
							if (typeof dir === "string")
								props.onChange((act) => {
									if (act.type === "export")
										act.destination = { customPath: { dir } };
								});
						}}
					>
						Browse
					</Button>
				</div>
			</Field>
		</div>
	);
}
