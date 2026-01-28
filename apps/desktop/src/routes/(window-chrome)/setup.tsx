import { Button } from "@inflight/ui-solid";
import { makePersisted } from "@solid-primitives/storage";
import { createTimer } from "@solid-primitives/timer";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
	createEffect,
	createResource,
	createSignal,
	For,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
	startTransition,
} from "solid-js";
import { createStore } from "solid-js/store";
import ModeSelect from "~/components/ModeSelect";
import {
	commands,
	type OSPermission,
	type OSPermissionStatus,
} from "~/utils/tauri";
import IconLucideVolumeX from "~icons/lucide/volume-x";
import welcome from "../../assets/illustrations/welcome.webp";

function isPermitted(status?: OSPermissionStatus): boolean {
	return status === "granted" || status === "notNeeded";
}

const permissions = [
	{
		name: "Screen Recording",
		key: "screenRecording" as const,
		description: "Share any screen, window, or app",
	},
	{
		name: "Accessibility",
		key: "accessibility" as const,
		description:
			"Inflight collects mouse activity to create video cursor flyovers",
	},
] as const;

export default function () {
	const [initialCheck, setInitialCheck] = createSignal(true);
	const [check, checkActions] = createResource(() =>
		commands.doPermissionsCheck(initialCheck()),
	);
	const [currentStep, setCurrentStep] = createSignal<"permissions" | "mode">(
		"permissions",
	);

	onMount(() => {
		setInitialCheck(false);
		createTimer(
			() => startTransition(() => checkActions.refetch()),
			500,
			setInterval,
		);
	});

	const requestPermission = async (permission: OSPermission) => {
		try {
			await commands.requestPermission(permission);
		} catch (err) {
			console.error(`Error occurred while requesting permission: ${err}`);
		}
		setInitialCheck(false);
	};

	const openSettings = (permission: OSPermission) => {
		commands.openPermissionSettings(permission);
		setInitialCheck(false);
	};

	const [showStartup, showStartupActions] = createResource(() =>
		generalSettingsStore.get().then((s) => {
			if (s === undefined) return true;
			return !s.hasCompletedStartup;
		}),
	);

	const handleContinue = () => {
		generalSettingsStore.set({
			hasCompletedStartup: true,
		});

		commands.showWindow({ Main: { init_target_mode: null } }).then(() => {
			getCurrentWindow().close();
		});
	};

	return (
		<div class="flex flex-row gap-0 pl-14 text-[0.875rem] font-[400] flex-1 bg-neutral-950 relative">
			{/* {showStartup() && (
				<Startup
					onClose={() => {
						showStartupActions.mutate(false);
					}}
				/>
			)} */}

			<Show when={currentStep() === "permissions"}>
				<div class="flex flex-col items-start justify-center gap-8 w-[380px] z-10">
					<div class="flex flex-col gap-2 items-start">
						<LogoSquare class="text-white" />
						<h1 class="text-[32px] text-white font-medium leading-tight">
							The screen recorder <br /> for designers
						</h1>
						<p class="text-white/70 text-sm">
							Grant permissions to create your first flyover
						</p>
					</div>

					<ul class="flex flex-col gap-8 p-6 rounded-[12px] border border-dashed border-white/10 bg-neutral-900/70">
						<For each={permissions}>
							{(permission) => {
								const permissionCheck = () => check()?.[permission.key];

								return (
									<Show when={permissionCheck() !== "notNeeded"}>
										<li class="flex flex-row items-center justify-between gap-8">
											<div class="flex flex-col gap-2">
												<span class="font-[500] text-[0.875rem] text-white">
													{permission.name} Permission
												</span>
												<span class="text-white/70">
													{permission.description}
												</span>
											</div>
											<button
												class="flex items-center justify-center h-8 px-3 rounded-[8px] border border-white/10 disabled:opacity-50 whitespace-nowrap text-white bg-white/10 hover:bg-white/20"
												onClick={() =>
													permissionCheck() !== "denied"
														? requestPermission(permission.key)
														: openSettings(permission.key)
												}
												disabled={isPermitted(permissionCheck())}
											>
												{permissionCheck() === "granted"
													? "Granted"
													: permissionCheck() !== "denied"
														? "Grant"
														: "Grant"}
											</button>
										</li>
									</Show>
								);
							}}
						</For>
					</ul>

					<button
						type="button"
						class="flex items-center justify-center h-10 px-4 rounded-[8px] border border-white/10 disabled:opacity-50 whitespace-nowrap text-white bg-white/10 hover:bg-white/20 gap-1"
						disabled={
							permissions.find((p) => !isPermitted(check()?.[p.key])) !==
							undefined
						}
						onClick={handleContinue}
					>
						<span class="text-sm font-medium">Get Started</span>
						<ArrowRightIcon class="size-4" />
					</button>
				</div>
			</Show>

			<div class="absolute right-0 w-[410px] h-full">
				<img
					class="absolute inset-0 w-full h-full object-cover"
					src={welcome}
					alt="Welcome to Inflight"
					draggable={false}
				/>
				<div
					class="absolute inset-0 pointer-events-none"
					style={{
						background:
							"linear-gradient(to left, transparent 60%, rgb(10 10 10) 95%)",
					}}
				/>
			</div>

			{/* <Show when={currentStep() === "mode"}>
				<div class="flex flex-col items-center">
					<IconCapLogo class="size-14 mb-3" />
					<h1 class="text-[1.2rem] font-[700] mb-1 text-[--text-primary]">Select Recording Mode</h1>
					<p class="text-gray-11">Choose how you want to record with Inflight. You can change this later.</p>
				</div>

				<div class="w-full py-4">
					<ModeSelect />
				</div>

				<Button class="px-12" size="lg" onClick={handleContinue}>
					Continue to Inflight
				</Button>
			</Show> */}
		</div>
	);
}

import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import { Portal } from "solid-js/web";
import CaptionControlsWindows11 from "~/components/titlebar/controls/CaptionControlsWindows11";
import { ArrowRightIcon, LogoSquare } from "~/icons";
import { generalSettingsStore } from "~/store";
import cloud1 from "../../assets/illustrations/cloud-1.png";
import cloud2 from "../../assets/illustrations/cloud-2.png";
import cloud3 from "../../assets/illustrations/cloud-3.png";
import startupAudio from "../../assets/tears-and-fireflies-adi-goldstein.mp3";

function Startup(props: { onClose: () => void }) {
	const [audioState, setAudioState] = makePersisted(
		createStore({ isMuted: false }),
		{ name: "audioSettings" },
	);

	const [isExiting, setIsExiting] = createSignal(false);

	const audio = new Audio(startupAudio);
	if (!audioState.isMuted) audio.play();

	// Add refs to store animation objects
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

	const handleStartupCompleted = () =>
		generalSettingsStore.set({
			hasCompletedStartup: true,
		});

	const handleGetStarted = async () => {
		setIsExiting(true);

		// Cancel ongoing cloud animations
		cloud1Animation?.cancel();
		cloud2Animation?.cancel();
		cloud3Animation?.cancel();

		await handleStartupCompleted();

		// Wait for animation to complete before showing new window and closing
		setTimeout(async () => {
			props.onClose();
		}, 600);
	};

	onCleanup(() => audio.pause());

	onMount(() => {
		const cloud1El = document.getElementById("cloud-1");
		const cloud2El = document.getElementById("cloud-2");
		const cloud3El = document.getElementById("cloud-3");

		// Top right cloud - gentle diagonal movement
		cloud1Animation = cloud1El?.animate(
			[
				{ transform: "translate(0, 0)" },
				{ transform: "translate(-20px, 10px)" },
				{ transform: "translate(0, 0)" },
			],
			{
				duration: 30000,
				iterations: Infinity,
				easing: "linear",
			},
		);

		// Top left cloud - gentle diagonal movement
		cloud2Animation = cloud2El?.animate(
			[
				{ transform: "translate(0, 0)" },
				{ transform: "translate(20px, 10px)" },
				{ transform: "translate(0, 0)" },
			],
			{
				duration: 35000,
				iterations: Infinity,
				easing: "linear",
			},
		);

		// Bottom cloud - slow rise up with subtle horizontal movement
		cloud3Animation = cloud3El?.animate(
			[
				{ transform: "translate(-50%, 20px)" },
				{ transform: "translate(-48%, 0)" },
				{ transform: "translate(-50%, 0)" },
			],
			{
				duration: 60000,
				iterations: 1,
				easing: "cubic-bezier(0.4, 0, 0.2, 1)",
				fill: "forwards",
			},
		);
	});

	const toggleMute = async () => {
		setAudioState("isMuted", (m) => !m);

		audio.muted = audioState.isMuted;
	};

	return (
		<Portal>
			<div class="absolute inset-0 z-40">
				<header
					class="absolute top-0 inset-x-0 h-12 z-10"
					data-tauri-drag-region
				>
					<div
						class={cx(
							"flex justify-between items-center gap-[0.25rem] w-full h-full z-10",
							ostype() === "windows" ? "flex-row" : "flex-row-reverse",
						)}
						data-tauri-drag-region
					>
						<button
							onClick={toggleMute}
							class={cx(
								"mx-4 text-solid-white hover:text-[#DDD] transition-colors",
								isExiting() && "opacity-0",
							)}
						>
							{audioState.isMuted ? (
								<IconLucideVolumeX class="w-6 h-6" />
							) : (
								<IconLucideVolume2 class="w-6 h-6" />
							)}
						</button>
						{ostype() === "windows" && <CaptionControlsWindows11 />}
					</div>
				</header>
				<style>
					{`
          body {
            background: transparent !important;
          }

          .content-container {
            transition: all 600ms cubic-bezier(0.4, 0, 0.2, 1);
          }

          .content-container.exiting {
            opacity: 0;
            transform: scale(1.1);
          }

          .custom-bg {
            transition: all 600ms cubic-bezier(0.4, 0, 0.2, 1);
          }

          .cloud-1.exiting {
            transform: translate(-200px, -150px) !important;
            opacity: 0 !important;
          }

          .cloud-2.exiting {
            transform: translate(200px, -150px) !important;
            opacity: 0 !important;
          }

          .cloud-3.exiting {
            transform: translate(-50%, 200px) !important;
            opacity: 0 !important;
          }

          .cloud-transition {
            transition: transform 600ms cubic-bezier(0.4, 0, 0.2, 1),
                        opacity 600ms cubic-bezier(0.4, 0, 0.2, 1) !important;
          }

          .cloud-image {
            max-width: 100vw;
            height: auto;
          }

          .grain {
            position: fixed;
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

          /* Overlay for fade to black */
          .fade-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: transparent;
            opacity: 0;
            pointer-events: none;
            transition: opacity 600ms cubic-bezier(0.4, 0, 0.2, 1);
            z-index: 1000;
          }

          .fade-overlay.exiting {
            opacity: 1;
          }

          @keyframes bounce {
            0%, 100% {
              transform: translateY(0);
            }
            50% {
              transform: translateY(-20px);
            }
          }

          .logo-bounce {
            animation: bounce 1s cubic-bezier(0.36, 0, 0.66, -0.56) forwards;
          }
        `}
				</style>
				{/* Add the fade overlay */}
				<div class={`fade-overlay ${isExiting() ? "exiting" : ""}`} />
				<div
					style={{ "transition-duration": "600ms" }}
					class={cx(
						"flex flex-col h-screen custom-bg relative overflow-hidden transition-opacity text-solid-white",
						isExiting() && "exiting opacity-0",
					)}
				>
					<div class="grain" />

					{/* Floating clouds */}
					<div
						id="cloud-1"
						class={`absolute top-0 right-0 opacity-70 pointer-events-none cloud-transition cloud-1 ${
							isExiting() ? "exiting" : ""
						}`}
					>
						<img
							class="cloud-image w-[100vw] md:w-[80vw] -mr-40"
							src={cloud1}
							alt="Cloud One"
						/>
					</div>
					<div
						id="cloud-2"
						class={`absolute top-0 left-0 opacity-70 pointer-events-none cloud-transition cloud-2 ${
							isExiting() ? "exiting" : ""
						}`}
					>
						<img
							class="cloud-image w-[100vw] md:w-[80vw] -ml-40"
							src={cloud2}
							alt="Cloud Two"
						/>
					</div>
					<div
						id="cloud-3"
						class={`absolute -bottom-[15%] left-1/2 -translate-x-1/2 opacity-70 pointer-events-none cloud-transition cloud-3 ${
							isExiting() ? "exiting" : ""
						}`}
					>
						<img
							class="cloud-image w-[180vw] md:w-[180vw]"
							src={cloud3}
							alt="Cloud Three"
						/>
					</div>

					{/* Main content */}
					<div
						class={`content-container flex flex-col items-center justify-center flex-1 relative px-4 ${
							isExiting() ? "exiting" : ""
						}`}
					>
						<div class="text-center mb-8">
							<div
								onClick={handleLogoClick}
								class="cursor-pointer inline-block"
							>
								<IconCapLogo
									class={`w-20 h-24 mx-auto drop-shadow-[0_0_100px_rgba(0,0,0,0.2)]
                  ${isLogoAnimating() ? "logo-bounce" : ""}`}
								/>
							</div>
							<h1 class="text-5xl md:text-5xl font-bold mb-4 drop-shadow-[0_0_20px_rgba(0,0,0,0.2)]">
								Welcome to Inflight
							</h1>
							<p class="text-2xl opacity-80 max-w-md mx-auto drop-shadow-[0_0_20px_rgba(0,0,0,0.2)]">
								Beautiful screen recordings, owned by you.
							</p>
						</div>

						<Switch>
							<Match when={ostype() !== "windows"}>
								<Button
									class="px-12 text-lg shadow-[0_0_30px_rgba(0,0,0,0.1)]"
									variant="gray"
									size="lg"
									onClick={handleGetStarted}
								>
									Get Started
								</Button>
							</Match>
							<Match when={ostype() === "windows"}>
								<Button
									class="px-12"
									size="lg"
									onClick={async () => {
										handleStartupCompleted();
										await commands.showWindow({
											Main: { init_target_mode: null },
										});
										getCurrentWindow().close();
									}}
								>
									Continue to Inflight
								</Button>
							</Match>
						</Switch>
					</div>
				</div>
			</div>
		</Portal>
	);
}
