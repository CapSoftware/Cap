import { useNavigate } from "@solidjs/router";
import { createQuery } from "@tanstack/solid-query";
import { getVersion } from "@tauri-apps/api/app";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Effect, getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import * as dialog from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { createSignal, createUniqueId, For, onMount } from "solid-js";
import { commands } from "~/utils/tauri";

export default function Debug() {
	const navigate = useNavigate();
	const [version, setVersion] = createSignal<string>("");
	const [updateStatus, setUpdateStatus] = createSignal<string>("");
	const [isChecking, setIsChecking] = createSignal(false);
	let mainContent: HTMLElement | undefined;

	onMount(async () => {
		const v = await getVersion();
		setVersion(v);

		if (mainContent) {
			const win = getCurrentWindow();
			const rect = mainContent.getBoundingClientRect();
			const size = new LogicalSize(rect.width, rect.height);
			win.setSize(size);
		}
	});

	const checkForUpdates = async () => {
		setIsChecking(true);
		setUpdateStatus("Checking...");
		try {
			const update = await check();
			if (update) {
				setUpdateStatus(`Update available: v${update.version}`);
			} else {
				setUpdateStatus("No update available");
			}
		} catch (e) {
			setUpdateStatus(`Error: ${e}`);
		}
		setIsChecking(false);
	};

	const simulateUpdatePopup = async () => {
		const fakeVersion = "99.0.0";
		setUpdateStatus(`Simulating update to v${fakeVersion}...`);

		const shouldUpdate = await dialog.confirm(
			`Version ${fakeVersion} of Cap is available, would you like to install it?`,
			{ title: "Update Cap", okLabel: "Update", cancelLabel: "Ignore" },
		);

		if (shouldUpdate) {
			navigate("/update");
		} else {
			setUpdateStatus("User declined update");
		}
	};

	const fails = createQuery(() => ({
		queryKey: ["fails"],
		queryFn: () => commands.listFails(),
	}));

	const orderedFails = () => Object.entries(fails.data ?? {});

	return (
		<main
			ref={mainContent}
			data-tauri-drag-region="deep"
			class="min-w-[500px] text-[--text-primary] p-4 pt-10 overflow-y-scroll"
		>
			<h2 class="text-xl font-bold">Debug Windows</h2>
			<div class="p-2 mb-4 flex gap-2">
				<button
					class="bg-blue-500 hover:bg-blue-600 text-white font-medium py-1 px-2 rounded"
					onClick={() => commands.showWindow("Onboarding")}
				>
					Show Onboarding Window
				</button>
				<button
					class="bg-blue-500 hover:bg-blue-600 text-white font-medium py-1 px-2 rounded"
					onClick={() =>
						commands.showWindow({ InProgressRecording: { countdown: 3 } })
					}
				>
					Show Recording Controls Window
				</button>
			</div>

			<h2 class="text-xl font-bold mt-4">Updates</h2>
			<div class="p-2 mb-2">
				<p class="mb-2 text-sm text-[--text-secondary]">
					Current version: v{version()}
				</p>
				<div class="flex flex-row gap-2 items-center">
					<button
						class="bg-blue-500 hover:bg-blue-600 text-white font-medium py-1 px-2 rounded disabled:opacity-50"
						onClick={checkForUpdates}
						disabled={isChecking()}
					>
						Check for Updates
					</button>
					<button
						class="bg-green-500 hover:bg-green-600 text-white font-medium py-1 px-2 rounded"
						onClick={() => navigate("/update")}
					>
						Go to Update Page
					</button>
					<button
						class="bg-purple-500 hover:bg-purple-600 text-white font-medium py-1 px-2 rounded disabled:opacity-50"
						onClick={simulateUpdatePopup}
						disabled={isChecking()}
					>
						Simulate Update Flow
					</button>
				</div>
				{updateStatus() && <p class="mt-2 text-sm">{updateStatus()}</p>}
			</div>

			<h2 class="text-2xl font-bold mt-1">Fail Points</h2>
			<ul class="p-2">
				<For each={orderedFails()}>
					{(fail) => {
						const id = createUniqueId();

						return (
							<li class="flex flex-row items-center gap-2">
								<input
									class="size-4"
									id={id}
									type="checkbox"
									checked={fail[1]}
									value={fail[1].toString()}
									onClick={(e) => {
										e.preventDefault();
										commands
											.setFail(fail[0], !fail[1])
											.then(() => fails.refetch());
									}}
								/>
								<label for={id}>{fail[0]}</label>
							</li>
						);
					}}
				</For>
			</ul>
		</main>
	);
}

export async function showCapDebugWindow() {
	const previous = await WebviewWindow.getByLabel("debug");
	if (previous) {
		previous.setFocus();
		return;
	}

	new WebviewWindow("debug", {
		url: "/debug",
		title: "Cap Debug",
		visible: false,
		titleBarStyle: "overlay",
		transparent: true,
		windowEffects: {
			effects: [Effect.UnderWindowBackground, Effect.Mica],
		},
	});
}
