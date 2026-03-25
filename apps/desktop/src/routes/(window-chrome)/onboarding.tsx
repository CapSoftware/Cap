import { Button } from "@cap/ui-solid";
import { makePersisted } from "@solid-primitives/storage";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { type as ostype } from "@tauri-apps/plugin-os";
import { relaunch } from "@tauri-apps/plugin-process";
import * as shell from "@tauri-apps/plugin-shell";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	type JSX,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { createStore } from "solid-js/store";
import { generalSettingsStore } from "~/store";
import {
	commands,
	type OSPermission,
	type OSPermissionStatus,
} from "~/utils/tauri";
import IconCapCaretDown from "~icons/cap/caret-down";
import IconCapCursorMacos from "~icons/cap/cursor-macos";
import IconCapCursorWindows from "~icons/cap/cursor-windows";
import IconCapFilmCut from "~icons/cap/film-cut";
import IconCapInstant from "~icons/cap/instant";
import IconCapMicrophone from "~icons/cap/microphone";
import IconCapMoreVertical from "~icons/cap/more-vertical";
import IconCapPauseCircle from "~icons/cap/pause-circle";
import IconCapRestart from "~icons/cap/restart";
import IconCapScreenshot from "~icons/cap/screenshot";
import IconCapSettings from "~icons/cap/settings";
import IconCapStopCircle from "~icons/cap/stop-circle";
import IconCapTrash from "~icons/cap/trash";
import IconLucideArrowLeft from "~icons/lucide/arrow-left";
import IconLucideArrowRight from "~icons/lucide/arrow-right";
import IconLucideCheck from "~icons/lucide/check";
import IconLucideChevronDown from "~icons/lucide/chevron-down";
import IconLucideCopy from "~icons/lucide/copy";
import IconLucideExternalLink from "~icons/lucide/external-link";
import IconLucideSave from "~icons/lucide/save";
import IconLucideShield from "~icons/lucide/shield";
import IconLucideVolume2 from "~icons/lucide/volume-2";
import IconLucideVolumeX from "~icons/lucide/volume-x";
import cloud1 from "../../assets/illustrations/cloud-1.png";
import cloud2 from "../../assets/illustrations/cloud-2.png";
import cloud3 from "../../assets/illustrations/cloud-3.png";
import startupAudio from "../../assets/tears-and-fireflies-adi-goldstein.mp3";
import { WindowChromeHeader } from "./Context";

type ModeId = "instant" | "studio" | "screenshot";

interface ModeDetail {
	id: ModeId;
	title: string;
	tagline: string;
	description: string;
	icon: typeof IconCapInstant;
	features: string[];
}

const modes: ModeDetail[] = [
	{
		id: "instant",
		title: "Instant Mode",
		tagline: "Record & share in seconds",
		description:
			"Your recording uploads as you capture. Stop recording and instantly get a shareable link — no waiting.",
		icon: IconCapInstant,
		features: [
			"Instant shareable link",
			"Background uploading",
			"AI transcription & summary",
			"Browser-based playback",
		],
	},
	{
		id: "studio",
		title: "Studio Mode",
		tagline: "Professional editing tools",
		description:
			"Record in full quality locally, then use the built-in editor to add backgrounds, padding, cursor effects, and more.",
		icon: IconCapFilmCut,
		features: [
			"Full quality local recording",
			"Built-in editor & effects",
			"Custom backgrounds & padding",
			"Export or share when ready",
		],
	},
	{
		id: "screenshot",
		title: "Screenshot Mode",
		tagline: "Capture & beautify instantly",
		description:
			"Take screenshots with a single hotkey, add annotations and beautiful backgrounds, then share or copy instantly.",
		icon: IconCapScreenshot,
		features: [
			"Instant hotkey capture",
			"Annotation & drawing tools",
			"Beautiful backgrounds",
			"Copy, save, or share",
		],
	},
];

function isPermitted(status?: OSPermissionStatus): boolean {
	return status === "granted" || status === "notNeeded";
}

type SetupPermission = {
	name: string;
	key: OSPermission;
	description: string;
	requiresManualGrant: boolean;
	optional?: boolean;
};

const setupPermissions: readonly SetupPermission[] = [
	{
		name: "Screen Recording",
		key: "screenRecording",
		description:
			"Click Grant to allow when macOS asks, or pick Cap in System Settings if needed. Restart the app after allowing screen recording.",
		requiresManualGrant: false,
	},
	{
		name: "Accessibility",
		key: "accessibility",
		description:
			"During recording, Cap collects mouse activity locally to generate automatic zoom in segments.",
		requiresManualGrant: false,
	},
	{
		name: "Microphone",
		key: "microphone",
		description: "This permission is required to record audio in your Caps.",
		requiresManualGrant: false,
		optional: true,
	},
	{
		name: "Camera",
		key: "camera",
		description:
			"This permission is required to record your camera in your Caps.",
		requiresManualGrant: false,
		optional: true,
	},
];

function createLoopingPhase(
	active: () => boolean,
	timings: number[],
	cycleDuration: number,
): () => number {
	const [phase, setPhase] = createSignal(0);

	createEffect(() => {
		if (!active()) {
			setPhase(0);
			return;
		}

		let timers: ReturnType<typeof setTimeout>[] = [];
		let cycleTimer: ReturnType<typeof setTimeout>;

		const clearAll = () => {
			for (const t of timers) clearTimeout(t);
			timers = [];
			clearTimeout(cycleTimer);
		};

		const run = () => {
			clearAll();
			setPhase(0);
			timers = timings.map((delay, i) =>
				setTimeout(() => setPhase(i + 1), delay),
			);
			cycleTimer = setTimeout(run, cycleDuration);
		};

		run();
		onCleanup(clearAll);
	});

	return phase;
}

function OnboardingAmbientBackdrop() {
	let cloud1Animation: Animation | undefined;
	let cloud2Animation: Animation | undefined;
	let cloud3Animation: Animation | undefined;

	const bindCloud1 = (el: HTMLDivElement | null) => {
		cloud1Animation?.cancel();
		cloud1Animation = undefined;
		if (!el) return;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				cloud1Animation = el.animate(
					[
						{ transform: "translate(0, 0)" },
						{ transform: "translate(-20px, 10px)" },
						{ transform: "translate(0, 0)" },
					],
					{ duration: 30000, iterations: Infinity, easing: "linear" },
				);
			});
		});
	};

	const bindCloud2 = (el: HTMLDivElement | null) => {
		cloud2Animation?.cancel();
		cloud2Animation = undefined;
		if (!el) return;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				cloud2Animation = el.animate(
					[
						{ transform: "translate(0, 0)" },
						{ transform: "translate(20px, 10px)" },
						{ transform: "translate(0, 0)" },
					],
					{ duration: 35000, iterations: Infinity, easing: "linear" },
				);
			});
		});
	};

	const bindCloud3Inner = (el: HTMLDivElement | null) => {
		cloud3Animation?.cancel();
		cloud3Animation = undefined;
		if (!el) return;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				cloud3Animation = el.animate(
					[
						{ transform: "translate(0, 20px)" },
						{ transform: "translate(2%, 0)" },
						{ transform: "translate(0, 0)" },
					],
					{
						duration: 60000,
						iterations: Infinity,
						easing: "linear",
						direction: "alternate",
					},
				);
			});
		});
	};

	onMount(() => {
		onCleanup(() => {
			cloud1Animation?.cancel();
			cloud2Animation?.cancel();
			cloud3Animation?.cancel();
		});
	});

	return (
		<div
			class="absolute inset-0 z-0 overflow-hidden pointer-events-none opacity-[0.1]"
			aria-hidden="true"
		>
			<div class="absolute inset-0 custom-bg" />
			<div class="startup-grain" />
			<div
				ref={bindCloud1}
				class="absolute top-0 right-0 opacity-70 pointer-events-none z-[1]"
			>
				<img
					class="startup-cloud-image w-[100vw] md:w-[80vw] -mr-40"
					src={cloud1}
					alt=""
				/>
			</div>
			<div
				ref={bindCloud2}
				class="absolute top-0 left-0 opacity-70 pointer-events-none z-[1]"
			>
				<img
					class="startup-cloud-image w-[100vw] md:w-[80vw] -ml-40"
					src={cloud2}
					alt=""
				/>
			</div>
			<div class="absolute -bottom-[15%] left-1/2 -translate-x-1/2 opacity-70 pointer-events-none z-[1]">
				<div ref={bindCloud3Inner}>
					<img
						class="startup-cloud-image w-[180vw] md:w-[180vw]"
						src={cloud3}
						alt=""
					/>
				</div>
			</div>
		</div>
	);
}

export default function OnboardingPage() {
	const [step, setStep] = createSignal(0);
	const [showStartupOverlay, setShowStartupOverlay] = createSignal(true);
	const [isExiting, setIsExiting] = createSignal(false);
	const [permissionsNeeded, setPermissionsNeeded] = createSignal(false);
	const [permsGranted, setPermsGranted] = createSignal(false);
	const [corePermsGranted, setCorePermsGranted] = createSignal(false);
	const [ready, setReady] = createSignal(false);

	const settings = generalSettingsStore.createQuery();
	const isRevisit = createMemo(
		() => settings.data?.hasCompletedOnboarding === true,
	);

	createEffect(() => {
		if (settings.data?.hasCompletedStartup && showStartupOverlay()) {
			setShowStartupOverlay(false);
		}
	});

	const isMacOS = createMemo(() => ostype() === "macos");
	const permissionsOnly = createMemo(() => isRevisit() && permissionsNeeded());

	const totalSteps = createMemo(() => {
		if (permissionsOnly()) return 1;
		return 8;
	});

	createEffect(() => {
		const s = settings.data;
		if (s === undefined || ready()) return;

		commands.doPermissionsCheck(true).then((check) => {
			const coreOk =
				isPermitted(check.screenRecording) && isPermitted(check.accessibility);
			const needs = !coreOk;
			setPermissionsNeeded(needs);
			setPermsGranted(coreOk);
			setCorePermsGranted(coreOk);
			setReady(true);
		});
	});

	const goToStep = (target: number) => {
		if (target < 0 || target >= totalSteps()) return;
		setStep(target);
	};

	const handleFinish = async () => {
		if (!isRevisit()) {
			await generalSettingsStore.set({ hasCompletedOnboarding: true });
		}
		await commands.showWindow({ Main: { init_target_mode: null } });
		getCurrentWindow().close();
	};

	const handleStartupDone = async () => {
		setIsExiting(true);
		await generalSettingsStore.set({ hasCompletedStartup: true });
		setTimeout(() => {
			setShowStartupOverlay(false);
			setIsExiting(false);
			if (!isMacOS()) {
				goToStep(1);
			}
		}, 600);
	};

	const handleNext = () => {
		if (permissionsOnly()) {
			handleFinish();
			return;
		}
		if (step() < totalSteps() - 1) goToStep(step() + 1);
		else handleFinish();
	};

	onMount(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (showStartupOverlay()) return;
			if (e.key === "ArrowRight") {
				e.preventDefault();
				if (!nextDisabled() && step() < totalSteps() - 1) goToStep(step() + 1);
			} else if (e.key === "ArrowLeft") {
				e.preventDefault();
				if (step() > 0) goToStep(step() - 1);
			} else if (e.key === "Enter") {
				e.preventDefault();
				if (!nextDisabled()) handleNext();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		onCleanup(() => window.removeEventListener("keydown", onKeyDown));
	});

	const nextLabel = () => {
		if (permissionsOnly()) return "Continue to Cap";
		if (step() === totalSteps() - 1) return "Start Using Cap";
		return "Continue";
	};

	const nextDisabled = () => step() === 0 && !permsGranted();

	const handleSkipOnboarding = () => {
		if (!corePermsGranted() || permissionsOnly()) return;
		handleFinish();
	};

	return (
		<>
			<WindowChromeHeader hideMaximize>
				<div
					class={cx(
						"flex items-center w-full mx-2",
						ostype() === "macos" && "flex-row-reverse",
					)}
					data-tauri-drag-region
				>
					{ostype() === "macos" && (
						<div class="flex-1" data-tauri-drag-region />
					)}
				</div>
			</WindowChromeHeader>
			<Show when={ready()}>
				<style>
					{`
					.custom-bg {
						transition: all 600ms cubic-bezier(0.4, 0, 0.2, 1);
					}
					.startup-grain {
						position: absolute;
						top: -150%;
						left: -50%;
						right: -50%;
						bottom: -150%;
						width: 200%;
						height: 400%;
						background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.5' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
						pointer-events: none;
						opacity: 0.5;
						z-index: 200;
						mix-blend-mode: overlay;
					}
					.startup-cloud-transition {
						transition: transform 600ms cubic-bezier(0.4, 0, 0.2, 1),
							opacity 600ms cubic-bezier(0.4, 0, 0.2, 1) !important;
					}
					.startup-cloud-1.exiting {
						transform: translate(-200px, -150px) !important;
						opacity: 0 !important;
					}
					.startup-cloud-2.exiting {
						transform: translate(200px, -150px) !important;
						opacity: 0 !important;
					}
					.startup-cloud-3.exiting {
						transform: translate(-50%, 200px) !important;
						opacity: 0 !important;
					}
					.startup-cloud-image {
						max-width: 100vw;
						height: auto;
					}
					@keyframes bounce {
						0%, 100% { transform: translateY(0); }
						50% { transform: translateY(-20px); }
					}
					.startup-logo-bounce {
						animation: bounce 1s cubic-bezier(0.36, 0, 0.66, -0.56) forwards;
					}
				`}
				</style>
				<div class="flex flex-col flex-1 min-h-0 overflow-hidden relative">
					<OnboardingAmbientBackdrop />
					<div class="relative flex-1 min-h-0 z-10">
						<StepPanel active={step() === 0} index={0} currentStep={step()}>
							<PermissionsStep
								active={step() === 0 && !showStartupOverlay()}
								onPermissionsChanged={setPermsGranted}
								onCorePermissionsChanged={setCorePermsGranted}
							/>
						</StepPanel>
						<Show when={!permissionsOnly()}>
							<StepPanel active={step() === 1} index={1} currentStep={step()}>
								<ModesOverviewStep active={step() === 1} />
							</StepPanel>
							<StepPanel active={step() === 2} index={2} currentStep={step()}>
								<ModeDetailStep mode={modes[0]} active={step() === 2}>
									<InstantMockup active={step() === 2} />
								</ModeDetailStep>
							</StepPanel>
							<StepPanel active={step() === 3} index={3} currentStep={step()}>
								<ModeDetailStep mode={modes[1]} active={step() === 3}>
									<StudioMockup active={step() === 3} />
								</ModeDetailStep>
							</StepPanel>
							<StepPanel active={step() === 4} index={4} currentStep={step()}>
								<ModeDetailStep mode={modes[2]} active={step() === 4}>
									<ScreenshotMockup active={step() === 4} />
								</ModeDetailStep>
							</StepPanel>
							<StepPanel active={step() === 5} index={5} currentStep={step()}>
								<ToggleStep active={step() === 5} />
							</StepPanel>
							<StepPanel active={step() === 6} index={6} currentStep={step()}>
								<ShortcutsStep active={step() === 6} />
							</StepPanel>
							<StepPanel active={step() === 7} index={7} currentStep={step()}>
								<FaqStep active={step() === 7} />
							</StepPanel>
						</Show>
					</div>
					<Show when={!showStartupOverlay() || isExiting()}>
						<StepNavigation
							current={step()}
							total={totalSteps()}
							onBack={() => goToStep(step() - 1)}
							onNext={handleNext}
							nextLabel={nextLabel()}
							showBack={step() > 0}
							nextDisabled={nextDisabled()}
							showSkipOnboarding={
								corePermsGranted() &&
								!permissionsOnly() &&
								!showStartupOverlay()
							}
							onSkip={handleSkipOnboarding}
						/>
					</Show>
					<Show when={showStartupOverlay()}>
						<StartupOverlay
							isExiting={isExiting()}
							onGetStarted={handleStartupDone}
						/>
					</Show>
				</div>
			</Show>
		</>
	);
}

function StepNavigation(props: {
	current: number;
	total: number;
	onBack: () => void;
	onNext: () => void;
	nextLabel: string;
	showBack: boolean;
	nextDisabled?: boolean;
	showSkipOnboarding?: boolean;
	onSkip?: () => void;
}) {
	return (
		<div class="flex flex-col items-center gap-2 px-8 pb-5 pt-2 shrink-0 relative z-40">
			<div class="flex items-center justify-between w-full">
				<div class="flex-1">
					<Show when={props.showBack}>
						<button
							type="button"
							onClick={props.onBack}
							class="flex items-center gap-1.5 text-[13px] text-gray-10 hover:text-gray-12 transition-colors duration-200"
						>
							<IconLucideArrowLeft class="size-3.5" />
							Back
						</button>
					</Show>
				</div>
				<div class="flex items-center gap-1">
					<For each={Array.from({ length: props.total })}>
						{(_, index) => (
							<div
								class={cx(
									"rounded-full transition-all duration-300",
									props.current === index()
										? "w-5 h-1.5 bg-gray-12"
										: props.current > index()
											? "w-1.5 h-1.5 bg-gray-8"
											: "w-1.5 h-1.5 bg-gray-5",
								)}
							/>
						)}
					</For>
				</div>
				<div class="flex-1 flex justify-end">
					<div class="flex flex-col items-center gap-1.5">
						<Button
							onClick={props.onNext}
							variant="primary"
							size="md"
							class="gap-2 px-10 py-3 min-h-12 min-w-[9.5rem] text-[15px] font-medium"
							disabled={props.nextDisabled}
						>
							{props.nextLabel}
							<Show
								when={props.current < props.total - 1}
								fallback={<IconLucideCheck class="size-4" />}
							>
								<IconLucideArrowRight class="size-4" />
							</Show>
						</Button>
						<Show when={props.showSkipOnboarding}>
							<button
								type="button"
								onClick={() => props.onSkip?.()}
								class="text-[11px] text-gray-9 hover:text-gray-11 transition-colors duration-200 py-0.5"
							>
								Skip onboarding
							</button>
						</Show>
					</div>
				</div>
			</div>
			<span class="text-[10px] text-gray-8 tabular-nums">
				Press Enter ↵ or use ← → arrow keys
			</span>
		</div>
	);
}

function StepPanel(props: {
	active: boolean;
	index: number;
	currentStep: number;
	children: JSX.Element;
}) {
	return (
		<div
			class="absolute inset-0 overflow-y-auto"
			style={{
				transform: props.active
					? "translateX(0)"
					: props.index < props.currentStep
						? "translateX(-40px)"
						: "translateX(40px)",
				opacity: props.active ? 1 : 0,
				"pointer-events": props.active ? "auto" : "none",
				transition:
					"transform 400ms cubic-bezier(0.4, 0, 0.2, 1), opacity 300ms ease",
			}}
		>
			{props.children}
		</div>
	);
}

function ModesOverviewStep(props: { active: boolean }) {
	const [visible, setVisible] = createSignal(false);

	createEffect(() => {
		if (props.active) {
			setVisible(false);
			const t = setTimeout(() => setVisible(true), 100);
			onCleanup(() => clearTimeout(t));
		} else {
			setVisible(false);
		}
	});

	return (
		<div class="flex flex-col items-center justify-center min-h-full px-10 gap-8">
			<div
				class={cx(
					"flex flex-col items-center gap-3 text-center max-w-[480px] transition-all duration-500 ease-out",
					visible() ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4",
				)}
			>
				<h2 class="text-2xl font-bold text-gray-12 tracking-tight">
					One app, every workflow
				</h2>
				<p class="text-[14px] text-gray-10 leading-relaxed">
					Whether you need speed, studio quality, or a quick screenshot — Cap
					has a mode for it.
				</p>
			</div>

			<div class="flex gap-4 w-full max-w-[540px]">
				<For each={modes}>
					{(mode, index) => (
						<div
							class="flex-1 flex flex-col items-center gap-3 p-5 rounded-2xl border border-gray-4 bg-white dark:bg-gray-2 transition-all duration-500 ease-out shadow-sm"
							style={{
								"transition-delay": `${200 + index() * 100}ms`,
								opacity: visible() ? 1 : 0,
								transform: visible()
									? "translateY(0) scale(1)"
									: "translateY(16px) scale(0.95)",
							}}
						>
							<div class="flex items-center justify-center size-12 rounded-2xl border border-gray-5 bg-white dark:bg-gray-3">
								<mode.icon class="size-5 invert dark:invert-0" />
							</div>
							<div class="text-center">
								<div class="text-sm font-semibold text-gray-12">
									{mode.title}
								</div>
								<div class="text-[11px] text-gray-9 mt-1 leading-snug">
									{mode.tagline}
								</div>
							</div>
						</div>
					)}
				</For>
			</div>
		</div>
	);
}

function ModeDetailStep(props: {
	mode: ModeDetail;
	active: boolean;
	children: JSX.Element;
}) {
	const [visible, setVisible] = createSignal(false);

	createEffect(() => {
		if (props.active) {
			setVisible(false);
			const t = setTimeout(() => setVisible(true), 80);
			onCleanup(() => clearTimeout(t));
		} else {
			setVisible(false);
		}
	});

	return (
		<div class="flex items-center min-h-full px-10 py-6 gap-8">
			<div class="w-[240px] shrink-0 flex flex-col justify-center">
				<div
					class={cx(
						"flex flex-col gap-4 transition-all duration-500 ease-out",
						visible() ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4",
					)}
				>
					<div class="flex items-center gap-3">
						<div class="flex items-center justify-center size-11 rounded-xl border border-gray-5 bg-white dark:bg-gray-3">
							<props.mode.icon class="size-5 invert dark:invert-0" />
						</div>
						<div>
							<h3 class="text-lg font-bold text-gray-12">{props.mode.title}</h3>
							<p class="text-[11px] font-medium text-gray-9">
								{props.mode.tagline}
							</p>
						</div>
					</div>

					<p class="text-[13px] text-gray-10 leading-relaxed">
						{props.mode.description}
					</p>

					<div class="flex flex-col gap-2.5">
						<For each={props.mode.features}>
							{(feature, index) => (
								<div
									class="flex items-center gap-2.5 transition-all duration-500"
									style={{
										"transition-delay": `${200 + index() * 60}ms`,
										opacity: visible() ? 1 : 0,
										transform: visible() ? "translateX(0)" : "translateX(-8px)",
									}}
								>
									<div class="flex items-center justify-center size-5 rounded-full shrink-0 bg-blue-9">
										<IconLucideCheck class="size-2.5 text-white" />
									</div>
									<span class="text-xs text-gray-11">{feature}</span>
								</div>
							)}
						</For>
					</div>
				</div>
			</div>

			<div class="flex-1 min-w-0 flex items-center justify-center">
				<div class="w-full h-full relative rounded-2xl bg-white dark:bg-gray-2 border border-gray-4 overflow-visible shadow-sm">
					{props.children}
				</div>
			</div>
		</div>
	);
}

function ToggleStep(props: { active: boolean }) {
	const [visible, setVisible] = createSignal(false);
	const [activeMode, setActiveMode] = createSignal(0);
	const [userClicked, setUserClicked] = createSignal(false);

	const CIRCLE = 80;
	const GAP = 24;
	const PAD = 16;

	createEffect(() => {
		if (props.active) {
			setVisible(false);
			setActiveMode(0);
			setUserClicked(false);
			const t = setTimeout(() => setVisible(true), 100);
			const interval = setInterval(() => {
				if (!userClicked()) setActiveMode((prev) => (prev + 1) % 3);
			}, 2500);
			onCleanup(() => {
				clearTimeout(t);
				clearInterval(interval);
			});
		} else {
			setVisible(false);
		}
	});

	const ringLeft = () => PAD + activeMode() * (CIRCLE + GAP);

	const handleModeClick = (index: number) => {
		setUserClicked(true);
		setActiveMode(index);
		commands.setRecordingMode(modes[index].id);
	};

	return (
		<div class="flex flex-col items-center justify-center min-h-full px-12 gap-8">
			<div
				class={cx(
					"flex flex-col items-center gap-3 text-center max-w-[420px] transition-all duration-500",
					visible() ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4",
				)}
			>
				<h2 class="text-2xl font-bold text-gray-12 tracking-tight">
					Switch modes anytime
				</h2>
				<p class="text-[14px] text-gray-10 leading-relaxed">
					Toggle between modes with a single click from the main Cap window.
				</p>
			</div>

			<div
				class={cx(
					"flex flex-col items-center gap-5 transition-all duration-700 delay-200",
					visible()
						? "opacity-100 translate-y-0 scale-100"
						: "opacity-0 translate-y-6 scale-95",
				)}
			>
				<div class="relative">
					<div class="absolute inset-0 rounded-full border border-gray-5 bg-white dark:bg-gray-3" />
					<div
						class="absolute rounded-full pointer-events-none transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
						style={{
							width: `${CIRCLE}px`,
							height: `${CIRCLE}px`,
							left: `${ringLeft()}px`,
							top: `${PAD}px`,
							"box-shadow": "0 0 0 3px var(--gray-1), 0 0 0 5px var(--blue-9)",
						}}
					/>
					<div
						class="relative flex"
						style={{ gap: `${GAP}px`, padding: `${PAD}px` }}
					>
						<For each={modes}>
							{(mode, index) => (
								<div
									class={cx(
										"rounded-full flex items-center justify-center transition-colors duration-300 cursor-pointer hover:brightness-95 border",
										activeMode() === index()
											? "bg-gray-7 border-transparent dark:border-gray-6"
											: "bg-white dark:bg-gray-4 border-gray-5 dark:border-gray-6",
									)}
									style={{
										width: `${CIRCLE}px`,
										height: `${CIRCLE}px`,
									}}
									onClick={() => handleModeClick(index())}
								>
									<mode.icon
										class={cx(
											"size-8 invert dark:invert-0 transition-all duration-300",
											activeMode() === index()
												? "scale-110 opacity-100"
												: "scale-100 opacity-50",
										)}
									/>
								</div>
							)}
						</For>
					</div>
				</div>

				<div
					class="flex"
					style={{
						gap: `${GAP}px`,
						"padding-left": `${PAD}px`,
						"padding-right": `${PAD}px`,
					}}
				>
					<For each={modes}>
						{(mode, index) => (
							<span
								class={cx(
									"text-sm font-medium text-center transition-all duration-300 cursor-pointer",
									activeMode() === index()
										? "text-gray-12"
										: "text-gray-9 opacity-50",
								)}
								style={{ width: `${CIRCLE}px` }}
								onClick={() => handleModeClick(index())}
							>
								{mode.title}
							</span>
						)}
					</For>
				</div>
			</div>
		</div>
	);
}

function ShortcutsStep(props: { active: boolean }) {
	const [visible, setVisible] = createSignal(false);

	createEffect(() => {
		if (props.active) {
			setVisible(false);
			const t = setTimeout(() => setVisible(true), 100);
			onCleanup(() => clearTimeout(t));
		} else {
			setVisible(false);
		}
	});

	const settingsAreas = [
		{
			title: "Keyboard Shortcuts",
			desc: "Global hotkeys for recording, screenshots, and switching modes",
		},
		{
			title: "Custom S3 Storage",
			desc: "Connect your own S3-compatible bucket for full control over your recordings",
		},
		{
			title: "Custom Domain",
			desc: "Use your own domain for shareable links instead of cap.link",
		},
		{
			title: "Recording Preferences",
			desc: "FPS, quality, countdown timer, cursor effects, and more",
		},
	];

	return (
		<div class="flex flex-col items-center justify-center min-h-full px-12 gap-6">
			<div
				class={cx(
					"flex flex-col items-center gap-3 text-center max-w-[440px] transition-all duration-500",
					visible() ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4",
				)}
			>
				<div class="flex items-center justify-center size-12 rounded-2xl bg-white dark:bg-gray-3 border border-gray-4">
					<IconCapSettings class="size-5 text-gray-11" />
				</div>
				<h2 class="text-2xl font-bold text-gray-12 tracking-tight">
					Make Cap yours
				</h2>
				<p class="text-[14px] text-gray-10 leading-relaxed">
					Customize everything from keyboard shortcuts to storage. Cap adapts to
					your workflow.
				</p>
			</div>

			<div
				class={cx(
					"w-full max-w-[420px] flex flex-col gap-2 transition-all duration-500 delay-100",
					visible() ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4",
				)}
			>
				<For each={settingsAreas}>
					{(area, index) => (
						<div
							class="flex flex-col gap-1 px-4 py-3 rounded-xl border border-gray-4 bg-white dark:bg-gray-2 transition-all duration-500 shadow-sm"
							style={{
								"transition-delay": `${150 + index() * 80}ms`,
								opacity: visible() ? 1 : 0,
								transform: visible() ? "translateY(0)" : "translateY(8px)",
							}}
						>
							<span class="text-[13px] font-medium text-gray-12">
								{area.title}
							</span>
							<span class="text-[11px] text-gray-10 leading-snug">
								{area.desc}
							</span>
						</div>
					)}
				</For>
			</div>

			<p
				class={cx(
					"text-xs text-gray-9 transition-all duration-500 delay-300",
					visible() ? "opacity-100" : "opacity-0",
				)}
			>
				Change any of these at any time in Settings
			</p>
		</div>
	);
}

function FaqStep(props: { active: boolean }) {
	const [visible, setVisible] = createSignal(false);

	createEffect(() => {
		if (props.active) {
			setVisible(false);
			const t = setTimeout(() => setVisible(true), 100);
			onCleanup(() => clearTimeout(t));
		} else {
			setVisible(false);
		}
	});

	return (
		<div class="flex flex-col items-center justify-center min-h-full px-12 py-6 gap-6">
			<div
				class={cx(
					"flex flex-col items-center gap-2 text-center transition-all duration-500",
					visible() ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4",
				)}
			>
				<h2 class="text-2xl font-bold text-gray-12 tracking-tight">
					Frequently Asked Questions
				</h2>
				<p class="text-[14px] text-gray-10">
					Everything you need to know to get started.
				</p>
			</div>

			<div
				class={cx(
					"w-full max-w-[480px] rounded-xl border border-gray-4 bg-white dark:bg-gray-2 overflow-hidden transition-all duration-500 delay-100 shadow-sm",
					visible() ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4",
				)}
			>
				<FaqItem question="Is Cap free to use?">
					<p class="text-[13px] text-gray-10 leading-relaxed">
						Cap is free for personal use. For teams and commercial use, check
						out our{" "}
						<button
							type="button"
							onClick={() => shell.open("https://cap.so/pricing")}
							class="text-blue-10 hover:text-blue-11 underline underline-offset-2"
						>
							pricing plans
						</button>
						.
					</p>
				</FaqItem>
				<FaqItem question="What's the difference between Instant and Studio?">
					<p class="text-[13px] text-gray-10 leading-relaxed">
						Instant mode uploads as you record — stop recording and you'll have
						a shareable link immediately. Studio mode records locally in full
						quality, letting you edit with backgrounds, effects, and more before
						sharing.
					</p>
				</FaqItem>
				<FaqItem question="Where are my recordings stored?">
					<p class="text-[13px] text-gray-10 leading-relaxed">
						All recordings are stored locally on your computer. In Instant mode,
						they're also uploaded to Cap's cloud for easy sharing. You can
						manage storage in Settings.
					</p>
				</FaqItem>
				<FaqItem question="Can I change my shortcuts later?">
					<p class="text-[13px] text-gray-10 leading-relaxed">
						Head to Settings → Shortcuts at any time to customize all your
						keyboard shortcuts.
					</p>
				</FaqItem>
				<FaqItem question="How does sharing work?">
					<p class="text-[13px] text-gray-10 leading-relaxed">
						In Instant mode, you get a shareable link automatically when you
						stop recording. In Studio mode, export your edited video and share
						via Cap's cloud or save locally.
					</p>
				</FaqItem>
			</div>

			<button
				type="button"
				onClick={() => shell.open("https://cap.so/pricing")}
				class={cx(
					"flex items-center gap-1.5 text-[13px] text-blue-10 hover:text-blue-11 transition-all duration-500 delay-200",
					visible() ? "opacity-100" : "opacity-0",
				)}
			>
				View pricing plans
				<IconLucideExternalLink class="size-3" />
			</button>
		</div>
	);
}

function FaqItem(props: { question: string; children: JSX.Element }) {
	const [open, setOpen] = createSignal(false);

	return (
		<div class="border-b border-gray-4 last:border-b-0">
			<button
				type="button"
				onClick={() => setOpen((p) => !p)}
				class="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-gray-2 dark:hover:bg-gray-3 transition-colors duration-200"
			>
				<span class="text-[13px] font-medium text-gray-12">
					{props.question}
				</span>
				<IconLucideChevronDown
					class={cx(
						"size-3.5 text-gray-9 shrink-0 transition-transform duration-300",
						open() && "rotate-180",
					)}
				/>
			</button>
			<div
				class="overflow-hidden transition-all duration-300 ease-out"
				style={{
					"max-height": open() ? "200px" : "0px",
					opacity: open() ? 1 : 0,
				}}
			>
				<div class="px-4 pb-3">{props.children}</div>
			</div>
		</div>
	);
}

function MockupStepBar(props: { steps: string[]; activeStep: number }) {
	return (
		<div class="flex items-center justify-center gap-2 pb-3">
			<For each={props.steps}>
				{(label, index) => (
					<>
						<Show when={index() > 0}>
							<div class="w-3 h-px bg-gray-5" />
						</Show>
						<div
							class={cx(
								"flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium transition-all duration-300",
								props.activeStep === index()
									? "bg-blue-3 text-blue-11 border border-blue-5"
									: props.activeStep > index()
										? "text-gray-10 bg-white dark:bg-gray-3 border border-gray-4"
										: "text-gray-8 border border-transparent",
							)}
						>
							<span class="font-bold">{index() + 1}</span>
							{label}
						</div>
					</>
				)}
			</For>
		</div>
	);
}

function StartRecordingClickMock(props: {
	active: boolean;
	mode: "instant" | "studio";
}) {
	const [cursorStage, setCursorStage] = createSignal(0);

	const cursorMoveMs = 1450;

	createEffect(() => {
		if (!props.active) {
			setCursorStage(0);
			return;
		}
		setCursorStage(0);
		const settleFrameMs = 40;
		const pauseAfterArriveMs = 280;
		const t1 = setTimeout(() => setCursorStage(1), settleFrameMs);
		const t2 = setTimeout(
			() => setCursorStage(2),
			settleFrameMs + cursorMoveMs + pauseAfterArriveMs,
		);
		onCleanup(() => {
			clearTimeout(t1);
			clearTimeout(t2);
		});
	});

	const modeLabel = () =>
		props.mode === "studio" ? "Studio Mode" : "Instant Mode";

	const cursorW = () => (ostype() === "windows" ? 24 : 22);
	const cursorH = () => (ostype() === "windows" ? 34 : 32);

	return (
		<div class="relative mx-auto w-full max-w-[18rem] overflow-visible pb-8">
			<div class="relative w-full">
				<div
					class={cx(
						"flex h-11 w-full overflow-hidden rounded-full bg-gradient-to-r from-blue-10 via-blue-10 to-blue-11 text-white transition-transform duration-500 ease-out dark:from-blue-9 dark:via-blue-9 dark:to-blue-10",
						cursorStage() === 2 && "scale-[0.98]",
					)}
				>
					<div class="flex min-w-0 flex-1 items-center py-1 pl-4 pointer-events-none">
						<Show
							when={props.mode === "studio"}
							fallback={<IconCapInstant class="size-4 shrink-0" />}
						>
							<IconCapFilmCut class="size-4 shrink-0" />
						</Show>
						<div class="mr-2 ml-3 flex min-w-0 flex-col">
							<span class="text-[0.95rem] font-medium text-nowrap text-white">
								Start Recording
							</span>
							<span class="-mt-0.5 flex items-center gap-1 text-[11px] font-light text-nowrap text-white/90">
								{modeLabel()}
							</span>
						</div>
					</div>
					<div class="flex shrink-0 items-center border-l border-white/20 bg-white/5 py-1.5 pl-2.5 pr-3">
						<IconCapCaretDown class="pointer-events-none" />
					</div>
				</div>
				<div
					class="pointer-events-none absolute z-10 transition-[top,left] ease-[cubic-bezier(0.22,0.82,0.28,1)]"
					style={{
						"transition-duration": `${cursorMoveMs}ms`,
						top:
							cursorStage() === 0 ? "calc(100% + 10px)" : "calc(100% - 18px)",
						left: cursorStage() === 0 ? "-2.75rem" : "28%",
						width: `${cursorW()}px`,
						height: `${cursorH()}px`,
					}}
				>
					<div
						class={cx(
							"size-full transition-transform duration-200 ease-out",
							cursorStage() === 2 && "translate-y-[3px] scale-[0.94]",
						)}
					>
						<Show
							when={ostype() === "windows"}
							fallback={<IconCapCursorMacos class="h-full w-full" />}
						>
							<IconCapCursorWindows class="h-full w-full" />
						</Show>
					</div>
				</div>
			</div>
		</div>
	);
}

function RecordingBar(props: {
	time: string;
	stopped?: boolean;
	class?: string;
}) {
	const actionIconWrap =
		"h-8 w-8 flex shrink-0 items-center justify-center rounded-lg p-[0.25rem] text-gray-11";

	return (
		<div class={cx("h-10 w-full min-w-[280px] rounded-2xl", props.class)}>
			<div class="flex h-full w-full flex-row items-stretch overflow-hidden rounded-2xl border border-gray-5 bg-white dark:bg-gray-1 shadow-[0_1px_3px_rgba(0,0,0,0.1)]">
				<div class="flex min-w-0 flex-1 flex-col gap-2 p-[0.25rem]">
					<div class="flex min-h-0 flex-1 flex-row items-center justify-between">
						<Show
							when={!props.stopped}
							fallback={
								<div class="flex flex-row items-center gap-[0.375rem] rounded-lg px-[0.5rem] py-[0.25rem] text-gray-10">
									<div class="size-2 shrink-0 rounded-full bg-gray-8" />
									<span class="text-[0.875rem] font-[500]">Stopped</span>
								</div>
							}
						>
							<button
								type="button"
								class="flex shrink-0 flex-row items-center gap-[0.25rem] rounded-lg px-[0.5rem] py-[0.25rem] text-red-300 transition-colors duration-100 hover:bg-red-500/[0.08] active:bg-red-500/[0.12]"
							>
								<IconCapStopCircle class="size-5 shrink-0" />
								<span class="text-[0.875rem] font-[500] tabular-nums">
									{props.time}
								</span>
							</button>
						</Show>
						<div
							class={cx(
								"flex shrink-0 items-center gap-1",
								props.stopped && "opacity-45",
							)}
						>
							<div class="relative flex h-8 w-8 shrink-0 items-center justify-center">
								<IconCapMicrophone class="size-5 text-gray-12" />
								<div class="absolute bottom-1 left-1 right-1 h-0.5 overflow-hidden rounded-full bg-gray-10">
									<div
										class="absolute inset-0 bg-blue-9"
										style={{ transform: "translateX(-40%)" }}
									/>
								</div>
							</div>
							<div class={actionIconWrap} aria-hidden="true">
								<IconCapPauseCircle class="size-5" />
							</div>
							<div class={actionIconWrap} aria-hidden="true">
								<IconCapRestart class="size-5" />
							</div>
							<div class={actionIconWrap} aria-hidden="true">
								<IconCapTrash class="size-5" />
							</div>
							<div class={actionIconWrap} aria-hidden="true">
								<IconCapSettings class="size-5" />
							</div>
						</div>
					</div>
				</div>
				<div
					class={cx(
						"flex w-9 shrink-0 cursor-default items-center justify-center border-l border-gray-5 p-[0.25rem] text-gray-10",
						props.stopped && "opacity-45",
					)}
					aria-hidden="true"
				>
					<IconCapMoreVertical class="pointer-events-none size-5" />
				</div>
			</div>
		</div>
	);
}

function InstantMockup(props: { active: boolean }) {
	const phase = createLoopingPhase(
		() => props.active,
		[300, 2350, 3350, 4350, 5350, 6350, 7350, 8350],
		9550,
	);

	const activeStep = () => {
		const p = phase();
		if (p <= 5) return 0;
		if (p <= 6) return 1;
		return 2;
	};

	const recordingTime = () => {
		const p = phase();
		if (p >= 5) return "0:03";
		if (p >= 4) return "0:02";
		if (p >= 3) return "0:01";
		if (p >= 2) return "0:00";
		return "0:00";
	};

	return (
		<div class="w-full h-full flex flex-col min-h-0 p-4">
			<MockupStepBar
				steps={["Record", "Stop", "Share link"]}
				activeStep={activeStep()}
			/>
			<div class="relative flex-1 min-h-[200px] w-full max-w-[420px] mx-auto">
				<div
					class={cx(
						"absolute inset-0 flex flex-col items-center justify-center transition-opacity duration-500 ease-[cubic-bezier(0.34,1.3,0.64,1)]",
						phase() >= 1 && phase() < 7
							? "opacity-100"
							: "pointer-events-none opacity-0",
					)}
				>
					<div class="relative min-h-[52px] w-full max-w-[400px]">
						<div
							class={cx(
								"flex w-full justify-center transition-all duration-[720ms] ease-[cubic-bezier(0.34,1.3,0.64,1)]",
								phase() === 1
									? "relative z-[2] translate-y-0 scale-100 opacity-100"
									: "pointer-events-none absolute inset-0 z-[1] flex items-center justify-center opacity-0 scale-[0.94] -translate-y-2",
							)}
						>
							<StartRecordingClickMock active={phase() === 1} mode="instant" />
						</div>
						<div
							class={cx(
								"w-full transition-all duration-[720ms] ease-[cubic-bezier(0.34,1.3,0.64,1)]",
								phase() >= 2 && phase() < 7
									? "relative z-[2] translate-y-0 scale-100 opacity-100"
									: "pointer-events-none absolute inset-0 z-[1] flex items-center justify-center opacity-0 scale-[0.94] translate-y-3",
							)}
						>
							<div class="w-full shadow-[0_8px_30px_rgba(0,0,0,0.08)]">
								<RecordingBar time={recordingTime()} stopped={phase() >= 6} />
							</div>
						</div>
					</div>
				</div>
				<div
					class={cx(
						"absolute inset-0 flex items-center justify-center transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
						phase() >= 7
							? "opacity-100 translate-y-0 scale-100"
							: "opacity-0 translate-y-4 scale-[0.97] pointer-events-none",
					)}
				>
					<div class="w-full max-w-[340px] rounded-xl overflow-hidden border border-gray-4 bg-white dark:bg-gray-1 shadow-lg">
						<div class="flex flex-col items-center gap-3 px-4 py-4">
							<div class="flex items-center gap-2">
								<div class="size-5 rounded-full bg-green-100 flex items-center justify-center shrink-0">
									<IconLucideCheck class="size-3 text-green-600" />
								</div>
								<span class="text-[12px] font-medium text-gray-12">
									Link ready to share!
								</span>
							</div>
							<div class="flex items-center gap-2 w-full">
								<div class="flex-1 flex items-center px-3 py-2 rounded-lg bg-white dark:bg-gray-3 border border-gray-4">
									<span class="text-[11px] text-gray-11 font-mono">
										cap.link/m4k92x
									</span>
								</div>
								<div
									class={cx(
										"flex items-center gap-1.5 px-3 py-2 rounded-lg border text-[11px] font-medium transition-all duration-300 shrink-0",
										phase() >= 8
											? "bg-green-50 border-green-200 text-green-700 scale-95"
											: "bg-white dark:bg-gray-3 border-gray-5 text-gray-11",
									)}
								>
									<Show
										when={phase() >= 8}
										fallback={
											<>
												<IconLucideCopy class="size-3" stroke-width={2} />
												Copy
											</>
										}
									>
										<IconLucideCheck class="size-3" />
										Copied!
									</Show>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function StudioMockup(props: { active: boolean }) {
	const phase = createLoopingPhase(
		() => props.active,
		[300, 2350, 3350, 4350, 5350, 6350, 7350, 8150, 9150, 10150, 11150],
		12250,
	);

	const activeStep = () => {
		const p = phase();
		if (p < 7) return 0;
		if (p < 9) return 1;
		return 2;
	};

	const showRecording = () => phase() < 7;
	const showEditor = () => phase() >= 7;
	const showExporting = () => phase() >= 9;

	const studioRecordingTime = () => {
		const p = phase();
		if (p >= 5) return "0:03";
		if (p >= 4) return "0:02";
		if (p >= 3) return "0:01";
		if (p >= 2) return "0:00";
		return "0:00";
	};

	const exportPercent = () => {
		const p = phase();
		if (p >= 11) return 100;
		if (p >= 10) return 75;
		if (p >= 9) return 25;
		return 0;
	};

	return (
		<div class="w-full h-full flex flex-col min-h-0 p-4">
			<MockupStepBar
				steps={["Record", "Edit", "Export"]}
				activeStep={activeStep()}
			/>
			<div class="relative flex-1 w-full max-w-[420px] min-h-[248px] mx-auto flex items-center justify-center">
				<div
					class={cx(
						"absolute inset-0 z-[1] flex flex-col items-center justify-center transition-opacity duration-[600ms] ease-out",
						showRecording()
							? "opacity-100 blur-0"
							: "pointer-events-none opacity-0 blur-[2px]",
					)}
				>
					<div class="relative min-h-[52px] w-full max-w-[400px]">
						<div
							class={cx(
								"flex w-full justify-center transition-all duration-[720ms] ease-[cubic-bezier(0.34,1.3,0.64,1)]",
								phase() === 1
									? "relative z-[2] translate-y-0 scale-100 opacity-100"
									: "pointer-events-none absolute inset-0 z-[1] flex items-center justify-center opacity-0 scale-[0.94] -translate-y-2",
							)}
						>
							<StartRecordingClickMock active={phase() === 1} mode="studio" />
						</div>
						<div
							class={cx(
								"w-full transition-all duration-[720ms] ease-[cubic-bezier(0.34,1.3,0.64,1)]",
								phase() >= 2 && phase() < 7
									? "relative z-[2] translate-y-0 scale-100 opacity-100"
									: "pointer-events-none absolute inset-0 z-[1] flex items-center justify-center opacity-0 scale-[0.94] translate-y-3",
							)}
						>
							<div class="w-full shadow-[0_8px_30px_rgba(0,0,0,0.08)]">
								<RecordingBar
									time={studioRecordingTime()}
									stopped={phase() >= 6}
								/>
							</div>
						</div>
					</div>
				</div>

				<div
					class={cx(
						"absolute inset-0 flex flex-col rounded-xl overflow-hidden border border-gray-3 bg-white dark:bg-gray-1 shadow-lg transition-all duration-[600ms] ease-out z-[2]",
						showEditor()
							? "opacity-100 scale-100 translate-y-0 blur-0"
							: "opacity-0 scale-[0.96] translate-y-3 blur-[2px] pointer-events-none",
					)}
				>
					<div class="flex items-center justify-between h-9 px-3 border-b border-gray-3 bg-white dark:bg-gray-1">
						<div class="flex items-center gap-2">
							<div class="flex gap-1">
								<div class="size-2 rounded-full bg-gray-6" />
								<div class="size-2 rounded-full bg-gray-6" />
								<div class="size-2 rounded-full bg-gray-6" />
							</div>
							<span class="text-[10px] text-gray-11 font-medium">
								Cap Editor
							</span>
						</div>
						<div
							class={cx(
								"px-2.5 py-1 rounded-md text-[9px] text-white font-medium transition-all duration-500 ease-out bg-blue-9",
								phase() >= 8
									? "scale-105 ring-2 ring-blue-9/50 ring-offset-2 ring-offset-white dark:ring-offset-gray-1"
									: "scale-100 ring-0 ring-offset-0",
							)}
						>
							Export
						</div>
					</div>

					<div class="flex bg-white dark:bg-gray-1 flex-1 relative">
						<div
							class={cx(
								"flex-1 p-3 transition-all duration-500",
								showEditor() ? "opacity-100" : "opacity-0",
							)}
						>
							<div class="relative rounded-lg overflow-hidden border border-gray-3 h-full">
								<div
									class="absolute inset-0"
									style={{
										background:
											"linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
									}}
								/>
								<div class="relative m-2.5 h-[80px] rounded-md bg-white/95 dark:bg-gray-1/95 border border-gray-3 shadow-md flex items-center justify-center">
									<div class="flex flex-col gap-1.5 p-3 w-full">
										<div class="w-3/4 h-1.5 rounded-full bg-gray-5/50" />
										<div class="w-1/2 h-1.5 rounded-full bg-gray-5/30" />
										<div class="w-full h-5 rounded bg-gray-5/20 mt-1" />
									</div>
								</div>
							</div>
						</div>

						<div
							class={cx(
								"w-[90px] shrink-0 border-l border-gray-3 bg-white dark:bg-gray-1 p-2 flex flex-col gap-1.5 transition-all duration-500",
								showEditor()
									? "opacity-100 translate-x-0"
									: "opacity-0 translate-x-2",
							)}
						>
							<div class="text-[8px] text-gray-9 font-medium uppercase tracking-wider">
								Style
							</div>
							<div class="h-5 rounded border border-gray-3 bg-white dark:bg-gray-2" />
							<div class="text-[8px] text-gray-9 font-medium uppercase tracking-wider mt-1">
								Background
							</div>
							<div class="flex gap-1">
								<div class="size-4 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 border border-gray-3" />
								<div class="size-4 rounded-full bg-gradient-to-br from-pink-400 to-orange-400 border border-gray-3" />
								<div class="size-4 rounded-full bg-gray-4 border border-gray-3" />
							</div>
						</div>

						<Show when={showExporting()}>
							<div class="absolute inset-0 bg-black/25 backdrop-blur-[2px] flex items-center justify-center z-10">
								<div class="bg-white dark:bg-gray-1 rounded-xl border border-gray-4 shadow-xl px-6 py-5 flex flex-col items-center gap-3 min-w-[200px]">
									<Show
										when={phase() < 11}
										fallback={
											<div class="flex items-center gap-2">
												<div class="size-6 rounded-full bg-green-100 flex items-center justify-center">
													<IconLucideCheck class="size-3.5 text-green-600" />
												</div>
												<span class="text-sm font-medium text-gray-12">
													Export complete!
												</span>
											</div>
										}
									>
										<span class="text-sm font-medium text-gray-12">
											Exporting...
										</span>
									</Show>
									<div class="w-full h-2 bg-gray-4 rounded-full overflow-hidden">
										<div
											class="h-full bg-blue-9 rounded-full transition-all ease-out"
											style={{
												width: `${exportPercent()}%`,
												"transition-duration":
													phase() >= 11 ? "800ms" : "600ms",
											}}
										/>
									</div>
									<span class="text-xs text-gray-10 tabular-nums font-medium">
										{exportPercent()}%
									</span>
								</div>
							</div>
						</Show>
					</div>

					<div
						class={cx(
							"px-3 pb-2 border-t border-gray-3 bg-white dark:bg-gray-1 transition-all duration-500",
							showEditor()
								? "opacity-100 translate-y-0"
								: "opacity-0 translate-y-2",
						)}
					>
						<div class="flex items-center gap-1.5 h-6 bg-white dark:bg-gray-2 rounded-lg px-2 border border-gray-3">
							<div class="flex-1 h-[3px] bg-gray-4 rounded-full relative">
								<div
									class="h-full bg-gray-8 rounded-full"
									style={{ width: "42%" }}
								/>
							</div>
							<span class="text-[8px] text-gray-10 tabular-nums font-medium">
								0:12
							</span>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function StartupOverlay(props: {
	isExiting: boolean;
	onGetStarted: () => void;
}) {
	const [audioState, setAudioState] = makePersisted(
		createStore({ isMuted: false }),
		{ name: "audioSettings" },
	);

	let audioEl: HTMLAudioElement | undefined;
	let cloud1Animation: Animation | undefined;
	let cloud2Animation: Animation | undefined;
	let cloud3Animation: Animation | undefined;

	const [isLogoAnimating, setIsLogoAnimating] = createSignal(false);

	const handleLogoClick = () => {
		if (!isLogoAnimating()) {
			setIsLogoAnimating(true);
			setTimeout(() => setIsLogoAnimating(false), 1000);
		}
	};

	const bindCloud1 = (el: HTMLDivElement | null) => {
		cloud1Animation?.cancel();
		cloud1Animation = undefined;
		if (!el) return;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				cloud1Animation = el.animate(
					[
						{ transform: "translate(0, 0)" },
						{ transform: "translate(-20px, 10px)" },
						{ transform: "translate(0, 0)" },
					],
					{ duration: 30000, iterations: Infinity, easing: "linear" },
				);
			});
		});
	};

	const bindCloud2 = (el: HTMLDivElement | null) => {
		cloud2Animation?.cancel();
		cloud2Animation = undefined;
		if (!el) return;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				cloud2Animation = el.animate(
					[
						{ transform: "translate(0, 0)" },
						{ transform: "translate(20px, 10px)" },
						{ transform: "translate(0, 0)" },
					],
					{ duration: 35000, iterations: Infinity, easing: "linear" },
				);
			});
		});
	};

	const bindCloud3Inner = (el: HTMLDivElement | null) => {
		cloud3Animation?.cancel();
		cloud3Animation = undefined;
		if (!el) return;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				cloud3Animation = el.animate(
					[
						{ transform: "translate(0, 20px)" },
						{ transform: "translate(2%, 0)" },
						{ transform: "translate(0, 0)" },
					],
					{
						duration: 60000,
						iterations: 1,
						easing: "cubic-bezier(0.4, 0, 0.2, 1)",
						fill: "forwards",
					},
				);
			});
		});
	};

	onMount(() => {
		audioEl = new Audio(startupAudio);
		audioEl.preload = "auto";
		audioEl.loop = false;
		audioEl.muted = audioState.isMuted;

		const tryPlay = () => {
			if (!audioEl || audioEl.muted) return;
			void audioEl.play().catch(() => {});
		};

		tryPlay();
		const resumeAudio = () => tryPlay();
		window.addEventListener("pointerdown", resumeAudio, { passive: true });

		onCleanup(() => {
			window.removeEventListener("pointerdown", resumeAudio);
			cloud1Animation?.cancel();
			cloud2Animation?.cancel();
			cloud3Animation?.cancel();
			audioEl?.pause();
			audioEl = undefined;
		});
	});

	const toggleMute = () => {
		const next = !audioState.isMuted;
		setAudioState("isMuted", next);
		if (audioEl) {
			audioEl.muted = next;
			if (!next) void audioEl.play().catch(() => {});
		}
	};

	const handleGetStarted = () => {
		cloud1Animation?.cancel();
		cloud2Animation?.cancel();
		cloud3Animation?.cancel();
		props.onGetStarted();
	};

	createEffect(() => {
		const exiting = props.isExiting;
		const onKeyDown = (e: KeyboardEvent) => {
			if (exiting) return;
			if (e.key !== " " && e.code !== "Space") return;
			e.preventDefault();
			handleGetStarted();
		};
		window.addEventListener("keydown", onKeyDown);
		onCleanup(() => window.removeEventListener("keydown", onKeyDown));
	});

	return (
		<div
			class={cx(
				"absolute inset-0 z-50 flex flex-col min-h-full h-full overflow-hidden custom-bg transition-all duration-[600ms] text-solid-white bg-white",
				props.isExiting && "opacity-0 scale-105 pointer-events-none",
			)}
		>
			<div class="startup-grain" />

			<div
				class="absolute top-3 z-[210]"
				style={{
					[ostype() === "macos" ? "right" : "left"]: "12px",
				}}
			>
				<button
					type="button"
					onClick={toggleMute}
					class={cx(
						"mx-1 text-solid-white hover:text-[#DDD] transition-colors p-1",
						props.isExiting && "opacity-0",
					)}
				>
					{audioState.isMuted ? (
						<IconLucideVolumeX class="w-6 h-6" />
					) : (
						<IconLucideVolume2 class="w-6 h-6" />
					)}
				</button>
			</div>

			<div
				ref={bindCloud1}
				class={cx(
					"absolute top-0 right-0 opacity-70 pointer-events-none startup-cloud-1 z-[1]",
					props.isExiting && "startup-cloud-transition exiting",
				)}
			>
				<img
					class="startup-cloud-image w-[100vw] md:w-[80vw] -mr-40"
					src={cloud1}
					alt=""
				/>
			</div>
			<div
				ref={bindCloud2}
				class={cx(
					"absolute top-0 left-0 opacity-70 pointer-events-none startup-cloud-2 z-[1]",
					props.isExiting && "startup-cloud-transition exiting",
				)}
			>
				<img
					class="startup-cloud-image w-[100vw] md:w-[80vw] -ml-40"
					src={cloud2}
					alt=""
				/>
			</div>
			<div
				class={cx(
					"absolute -bottom-[15%] left-1/2 -translate-x-1/2 opacity-70 pointer-events-none z-[1]",
					props.isExiting && "startup-cloud-transition startup-cloud-3 exiting",
				)}
			>
				<div ref={bindCloud3Inner}>
					<img
						class="startup-cloud-image w-[180vw] md:w-[180vw]"
						src={cloud3}
						alt=""
					/>
				</div>
			</div>

			<div
				class={cx(
					"flex flex-col items-center justify-center flex-1 relative px-4 z-[5]",
					props.isExiting && "opacity-0 scale-[1.1]",
				)}
				style={{ transition: "all 600ms cubic-bezier(0.4, 0, 0.2, 1)" }}
			>
				<div class="text-center">
					<div onClick={handleLogoClick} class="cursor-pointer inline-block">
						<IconCapLogo
							class={cx(
								"w-20 h-24 mx-auto drop-shadow-[0_0_100px_rgba(0,0,0,0.2)]",
								isLogoAnimating() && "startup-logo-bounce",
							)}
						/>
					</div>
					<h1 class="text-5xl md:text-5xl font-bold mb-4 mt-8 drop-shadow-[0_0_20px_rgba(0,0,0,0.2)]">
						Welcome to Cap
					</h1>
					<p class="text-xl md:text-2xl opacity-80 mx-auto drop-shadow-[0_0_20px_rgba(0,0,0,0.2)] whitespace-nowrap">
						Beautiful screen recordings, owned by you.
					</p>
				</div>

				<Button
					class="mt-14 px-16 py-4 min-h-[3.75rem] min-w-[15rem] text-xl font-medium shadow-[0_0_30px_rgba(0,0,0,0.12)] bg-white border border-white/30 text-gray-12 hover:bg-white/95 hover:border-white/40 flex-col gap-0.5"
					variant="white"
					size="lg"
					onClick={handleGetStarted}
				>
					<span>Get Started</span>
					<span class="text-[11px] font-normal text-gray-11 leading-tight inline-flex items-center justify-center gap-1">
						<span>Click here, or press</span>
						<kbd class="rounded border border-gray-6 bg-white dark:bg-gray-3 px-1 py-px text-[10px] font-medium text-gray-11 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
							Space
						</kbd>
					</span>
				</Button>
			</div>
		</div>
	);
}

function PermissionsStep(props: {
	active: boolean;
	onPermissionsChanged: (allRequired: boolean) => void;
	onCorePermissionsChanged: (granted: boolean) => void;
}) {
	const [visible, setVisible] = createSignal(false);
	const [initialCheck, setInitialCheck] = createSignal(true);
	const [check, setCheck] = createSignal<
		Record<string, OSPermissionStatus> | undefined
	>(undefined);

	const fetchPermissions = async () => {
		const result = await commands.doPermissionsCheck(initialCheck());
		setCheck(result as unknown as Record<string, OSPermissionStatus>);
	};

	onMount(() => {
		fetchPermissions();
	});

	createEffect(() => {
		if (props.active) {
			setVisible(false);
			const t = setTimeout(() => setVisible(true), 100);
			onCleanup(() => clearTimeout(t));
		} else {
			setVisible(false);
		}
	});

	createEffect(() => {
		if (props.active && !initialCheck()) {
			const interval = setInterval(fetchPermissions, 250);
			onCleanup(() => clearInterval(interval));
		}
	});

	createEffect(() => {
		const c = check();
		if (!c) return;
		const allRequired = setupPermissions
			.filter((p) => !p.optional)
			.every((p) => isPermitted(c[p.key]));
		props.onPermissionsChanged(allRequired);
		props.onCorePermissionsChanged(
			isPermitted(c.screenRecording) && isPermitted(c.accessibility),
		);
	});

	const maybePromptRestartForScreenRecording = async () => {
		const shouldRestart = await ask(
			"After adding Cap in System Settings, you'll need to restart the app for the permission to take effect.",
			{
				title: "Restart Required",
				kind: "info",
				okLabel: "Restart, I've granted permission",
				cancelLabel: "No, I still need to add it",
			},
		);
		if (shouldRestart) {
			await relaunch();
		}
	};

	const [requestingPermission, setRequestingPermission] = createSignal(false);

	const requestPermission = async (permission: OSPermission) => {
		if (requestingPermission()) return;
		setRequestingPermission(true);
		try {
			await commands.requestPermission(permission);
			setInitialCheck(false);
			const result = await commands.doPermissionsCheck(false);
			setCheck(result as unknown as Record<string, OSPermissionStatus>);
			const notYetPermitted =
				(permission === "screenRecording" &&
					!isPermitted(result.screenRecording)) ||
				(permission === "accessibility" && !isPermitted(result.accessibility));
			if (notYetPermitted) {
				await commands.openPermissionSettings(permission);
				if (permission === "screenRecording") {
					await maybePromptRestartForScreenRecording();
				}
			}
		} catch (err) {
			console.error(`Error requesting permission: ${err}`);
			fetchPermissions().catch(() => {});
		} finally {
			setRequestingPermission(false);
		}
	};

	const openSettings = async (permission: OSPermission) => {
		if (requestingPermission()) return;
		setRequestingPermission(true);
		try {
			await commands.openPermissionSettings(permission);
			if (permission === "screenRecording") {
				await maybePromptRestartForScreenRecording();
			}
			setInitialCheck(false);
			fetchPermissions();
		} catch (err) {
			console.error(`Error opening permission settings: ${err}`);
		} finally {
			setRequestingPermission(false);
		}
	};

	return (
		<div class="flex flex-col items-center justify-center min-h-full px-12 gap-6">
			<div
				class={cx(
					"flex flex-col items-center gap-3 text-center max-w-[440px] transition-all duration-500",
					visible() ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4",
				)}
			>
				<div class="flex items-center justify-center size-12 rounded-2xl bg-white dark:bg-gray-3 border border-gray-4">
					<IconLucideShield class="size-5 text-gray-11" />
				</div>
				<h2 class="text-2xl font-bold text-gray-12 tracking-tight">
					Permissions Required
				</h2>
				<p class="text-[14px] text-gray-10 leading-relaxed">
					Cap needs a few permissions to record your screen and capture audio.
				</p>
			</div>

			<div
				class={cx(
					"w-full max-w-[440px] flex flex-col gap-2 transition-all duration-500 delay-100",
					visible() ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4",
				)}
			>
				<For each={setupPermissions}>
					{(permission, index) => {
						const permStatus = () =>
							check()?.[permission.key] as OSPermissionStatus | undefined;

						return (
							<Show when={permStatus() !== "notNeeded"}>
								<div
									class="flex items-center gap-4 px-4 py-3 rounded-xl border border-gray-4 bg-white dark:bg-gray-2 transition-all duration-500 shadow-sm"
									style={{
										"transition-delay": `${150 + index() * 80}ms`,
										opacity: visible() ? 1 : 0,
										transform: visible() ? "translateY(0)" : "translateY(8px)",
									}}
								>
									<div class="flex flex-col flex-1 min-w-0">
										<div class="flex items-center gap-2">
											<span class="text-[13px] font-medium text-gray-12">
												{permission.name}
											</span>
											<Show when={permission.optional}>
												<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-2 dark:bg-gray-4 text-gray-9">
													Optional
												</span>
											</Show>
										</div>
										<span class="text-[11px] text-gray-10 leading-snug mt-0.5">
											{permission.description}
										</span>
									</div>
									<Show
										when={!isPermitted(permStatus())}
										fallback={
											<div class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-3 border border-green-5 text-green-11 text-[12px] font-medium shrink-0">
												<IconLucideCheck class="size-3" />
												Granted
											</div>
										}
									>
										<Button
											size="sm"
											variant="gray"
											class="shrink-0"
											disabled={requestingPermission()}
											onClick={() =>
												permission.requiresManualGrant ||
												permStatus() === "denied"
													? openSettings(permission.key)
													: requestPermission(permission.key)
											}
										>
											{permission.requiresManualGrant ||
											permStatus() === "denied"
												? "Open Settings"
												: "Grant"}
										</Button>
									</Show>
								</div>
							</Show>
						);
					}}
				</For>
			</div>
		</div>
	);
}

function ScreenshotMockup(props: { active: boolean }) {
	const phase = createLoopingPhase(
		() => props.active,
		[200, 700, 1400, 2600, 3400, 3900, 4900, 5900, 6700],
		8000,
	);

	const activeStep = () => {
		const p = phase();
		if (p <= 5) return 0;
		if (p <= 8) return 1;
		return 2;
	};

	const showEditor = () => phase() >= 6;

	return (
		<div class="w-full h-full flex flex-col items-center justify-center p-4">
			<MockupStepBar
				steps={["Select area", "Beautify", "Copy"]}
				activeStep={activeStep()}
			/>
			<div class="relative w-full max-w-[420px] h-[240px]">
				<div
					class="absolute inset-0 flex items-center justify-center transition-all duration-700"
					style={{
						opacity: !showEditor() ? 1 : 0,
						transform: !showEditor() ? "scale(1)" : "scale(0.96)",
						"pointer-events": !showEditor() ? "auto" : "none",
					}}
				>
					<div
						class={cx(
							"relative w-full max-w-[380px] h-[200px] rounded-xl overflow-hidden border border-gray-5 bg-white dark:bg-gray-3 transition-all duration-500",
							phase() >= 1
								? "opacity-100 translate-y-0 scale-100"
								: "opacity-0 translate-y-4 scale-95",
						)}
					>
						<div class="absolute inset-0 p-5 flex flex-col gap-2.5">
							<div class="w-20 h-2.5 rounded-full bg-gray-5/60" />
							<div class="w-36 h-2.5 rounded-full bg-gray-5/40" />
							<div class="w-28 h-2.5 rounded-full bg-gray-5/50" />
							<div class="mt-3 flex gap-3">
								<div class="flex-1 h-12 rounded-lg bg-gray-5/30" />
								<div class="flex-1 h-12 rounded-lg bg-gray-5/20" />
							</div>
						</div>

						<div
							class={cx(
								"absolute inset-0 transition-all duration-500",
								phase() >= 2 ? "bg-black/45" : "bg-transparent",
							)}
						/>

						<Show when={phase() >= 2 && phase() < 6}>
							<div
								class="absolute pointer-events-none z-10 transition-[top,left] ease-[cubic-bezier(0.22,0.82,0.28,1)]"
								style={{
									top: phase() >= 3 ? "calc(88% - 4px)" : "12%",
									left: phase() >= 3 ? "calc(90% - 4px)" : "8%",
									width: `${ostype() === "windows" ? 24 : 22}px`,
									height: `${ostype() === "windows" ? 34 : 32}px`,
									"transition-duration": "1200ms",
								}}
							>
								<Show
									when={ostype() === "windows"}
									fallback={<IconCapCursorMacos class="h-full w-full" />}
								>
									<IconCapCursorWindows class="h-full w-full" />
								</Show>
							</div>
						</Show>

						<div
							class="absolute border rounded-lg pointer-events-none"
							style={{
								top: "10%",
								left: "6%",
								right: phase() >= 3 ? "10%" : "94%",
								bottom: phase() >= 3 ? "12%" : "90%",
								"border-color":
									phase() >= 3 ? "rgba(255,255,255,0.6)" : "transparent",
								opacity: phase() >= 3 ? 1 : 0,
								transition:
									"right 1200ms cubic-bezier(0.22, 0.82, 0.28, 1), bottom 1200ms cubic-bezier(0.22, 0.82, 0.28, 1), border-color 200ms ease, opacity 200ms ease",
							}}
						>
							<Show when={phase() >= 4}>
								<For
									each={[
										"left-[-11px] top-[-11px]",
										"right-[-11px] top-[-11px]",
										"left-[-11px] bottom-[-11px]",
										"right-[-11px] bottom-[-11px]",
									]}
								>
									{(pos) => (
										<svg
											class={`absolute size-[22px] pointer-events-none ${pos} drop-shadow-[0_1px_3px_rgba(0,0,0,0.35)]`}
											viewBox="0 0 16 16"
											fill="none"
										>
											<path
												d={
													pos.includes("left") && pos.includes("top")
														? "M0 0 H12 M0 0 V12"
														: pos.includes("right") && pos.includes("top")
															? "M16 0 H4 M16 0 V12"
															: pos.includes("left") && pos.includes("bottom")
																? "M0 16 H12 M0 16 V4"
																: "M16 16 H4 M16 16 V4"
												}
												stroke="white"
												stroke-width="3"
												stroke-linecap="square"
											/>
										</svg>
									)}
								</For>
								<div class="absolute -bottom-7 left-1/2 -translate-x-1/2 bg-gray-12 text-[9px] font-mono px-2 py-0.5 rounded-full border border-gray-12 text-gray-1 shadow-md whitespace-nowrap tabular-nums">
									640 × 480
								</div>
							</Show>
						</div>

						<Show when={phase() === 5}>
							<div class="absolute inset-0 bg-white/30 animate-[pulse_300ms_ease-out_1]" />
						</Show>
					</div>
				</div>

				<div
					class="absolute inset-0 flex items-center justify-center transition-all duration-700"
					style={{
						opacity: showEditor() ? 1 : 0,
						transform: showEditor()
							? "translateY(0) scale(1)"
							: "translateY(8px) scale(0.98)",
						"pointer-events": showEditor() ? "auto" : "none",
					}}
				>
					<div class="w-full max-w-[420px] rounded-xl overflow-hidden border border-gray-3 bg-white dark:bg-gray-2 shadow-lg">
						<div class="flex relative flex-row items-center w-full h-10 px-3 border-b border-gray-3 shrink-0">
							<div class="flex flex-1 items-center gap-1">
								<div class="size-2 rounded-full bg-gray-6" />
								<div class="size-2 rounded-full bg-gray-6" />
								<div class="size-2 rounded-full bg-gray-6" />
							</div>
							<div class="flex items-center gap-1.5 absolute left-1/2 -translate-x-1/2">
								<div class="size-4 rounded bg-white dark:bg-gray-3 border border-gray-4" />
								<div class="size-4 rounded bg-white dark:bg-gray-3 border border-gray-4" />
								<div class="w-px h-5 bg-gray-4 mx-0.5" />
								<div class="size-4 rounded bg-blue-3 border border-blue-5" />
								<div class="size-4 rounded bg-white dark:bg-gray-3 border border-gray-4" />
								<div class="w-px h-5 bg-gray-4 mx-0.5" />
								<div class="size-4 rounded bg-white dark:bg-gray-3 border border-gray-4" />
							</div>
							<div class="flex flex-1 flex-row items-center justify-end gap-1.5">
								<div class="flex items-center gap-1 px-2 py-1 rounded-md bg-white dark:bg-gray-3 border border-gray-4 text-[9px] text-gray-11 font-medium">
									<IconLucideCopy class="size-3 shrink-0" stroke-width={2} />
									Copy
								</div>
								<div class="flex items-center gap-1 px-2 py-1 rounded-md bg-white dark:bg-gray-3 border border-gray-4 text-[9px] text-gray-11 font-medium">
									<IconLucideSave class="size-3 shrink-0" stroke-width={2} />
									Save
								</div>
							</div>
						</div>

						<div class="p-3 flex items-center justify-center">
							<div class="relative w-full h-[140px] rounded overflow-hidden">
								<div
									class="absolute inset-0 transition-opacity duration-[1000ms] ease-out"
									style={{
										background:
											"linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
										opacity: phase() >= 7 ? 1 : 0,
									}}
								/>

								<div
									class="absolute transition-all duration-[1000ms] ease-out"
									style={{
										top: phase() >= 8 ? "8%" : "0",
										left: phase() >= 8 ? "8%" : "0",
										right: phase() >= 8 ? "8%" : "0",
										bottom: phase() >= 8 ? "8%" : "0",
									}}
								>
									<div
										class="w-full h-full bg-white dark:bg-gray-3 flex flex-col gap-2 p-3 transition-all duration-[1000ms]"
										style={{
											"border-radius": phase() >= 8 ? "8px" : "0px",
											"box-shadow":
												phase() >= 8 ? "0 4px 20px rgba(0,0,0,0.2)" : "none",
										}}
									>
										<div class="w-16 h-2 rounded-full bg-gray-5/60" />
										<div class="w-28 h-2 rounded-full bg-gray-5/40" />
										<div class="w-20 h-2 rounded-full bg-gray-5/50" />
										<div class="mt-1 flex gap-2">
											<div class="flex-1 h-8 rounded bg-gray-5/30" />
											<div class="flex-1 h-8 rounded bg-gray-5/20" />
										</div>
									</div>
								</div>
							</div>
						</div>

						<div
							class="h-8 flex items-center justify-center transition-all duration-300"
							style={{
								opacity: phase() >= 9 ? 1 : 0,
								transform: phase() >= 9 ? "translateY(0)" : "translateY(4px)",
							}}
						>
							<div class="flex items-center gap-1.5 px-3 py-1 rounded-full bg-gray-12 text-gray-1 text-[10px] font-medium">
								<IconLucideCheck class="size-3" />
								Copied to clipboard
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
