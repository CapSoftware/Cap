import {
	Action,
	ActionPanel,
	Detail,
	Form,
	Icon,
	LocalStorage,
	showToast,
	Toast,
} from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import {
	CAP_URL_SCHEME,
	capNotInstalled,
	createListDevicesAction,
	createTakeScreenshotAction,
	type DeepLinkDevices,
	type DeepLinkScreen,
	type DeepLinkWindow,
	executeCapAction,
	executeCapActionWithResponse,
} from "./utils";

type CaptureType = "screen" | "window";
type RecentTarget = { type: CaptureType; name: string; timestamp: number };

const RECENT_SCREENSHOT_TARGETS_KEY = "recent-screenshot-targets";
const MAX_RECENT_TARGETS = 5;

function EmptyState({
	capNotRunning,
	onOpenCap,
}: {
	capNotRunning: boolean;
	onOpenCap: () => void;
}) {
	const markdown = capNotRunning
		? "## Cap Not Running\n\nPlease open Cap to take screenshots.\n\nIf you don't have Cap installed, you can download it from the website."
		: "## No Capture Targets Found\n\nCould not find any screens or windows to capture.\n\nMake sure screen recording permissions are granted.";

	return (
		<Detail
			markdown={markdown}
			actions={
				<ActionPanel>
					{capNotRunning ? (
						<>
							<Action
								title="Open Cap"
								icon={Icon.AppWindow}
								onAction={onOpenCap}
							/>
							<Action.OpenInBrowser
								title="Download Cap"
								url="https://cap.so/download"
							/>
						</>
					) : (
						<Action
							title="Retry"
							icon={Icon.RotateClockwise}
							onAction={() => {}}
						/>
					)}
				</ActionPanel>
			}
		/>
	);
}

export default function Command() {
	const [captureType, setCaptureType] = useState<CaptureType>("screen");
	const [selectedTarget, setSelectedTarget] = useState("");
	const [devices, setDevices] = useState<DeepLinkDevices | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [capNotRunning, setCapNotRunning] = useState(false);
	const [recentTargets, setRecentTargets] = useState<RecentTarget[]>([]);

	useEffect(() => {
		async function loadRecentTargets() {
			const stored = await LocalStorage.getItem<string>(
				RECENT_SCREENSHOT_TARGETS_KEY,
			);
			if (stored) {
				setRecentTargets(JSON.parse(stored));
			}
		}
		loadRecentTargets();
	}, []);

	useEffect(() => {
		async function loadDevices() {
			const notInstalled = await capNotInstalled();
			if (notInstalled) {
				setCapNotRunning(true);
				setIsLoading(false);
				return;
			}

			const result = await executeCapActionWithResponse<DeepLinkDevices>(
				createListDevicesAction(),
			);

			if (result && (result.screens.length > 0 || result.windows.length > 0)) {
				setDevices(result);
				const relevantRecent = recentTargets.find(
					(r) => r.type === captureType,
				);
				if (relevantRecent) {
					const exists =
						captureType === "screen"
							? result.screens.some(
									(s: DeepLinkScreen) => s.name === relevantRecent.name,
								)
							: result.windows.some(
									(w: DeepLinkWindow) => w.name === relevantRecent.name,
								);
					if (exists) {
						setSelectedTarget(relevantRecent.name);
					} else if (result.screens.length > 0) {
						setSelectedTarget(result.screens[0].name);
					}
				} else if (result.screens.length > 0) {
					setSelectedTarget(result.screens[0].name);
				}
			} else {
				setCapNotRunning(true);
			}
			setIsLoading(false);
		}

		loadDevices();
	}, [captureType, recentTargets]);

	async function saveRecentTarget(type: CaptureType, name: string) {
		const updated: RecentTarget[] = [
			{ type, name, timestamp: Date.now() },
			...recentTargets.filter((t) => !(t.type === type && t.name === name)),
		].slice(0, MAX_RECENT_TARGETS);
		setRecentTargets(updated);
		await LocalStorage.setItem(
			RECENT_SCREENSHOT_TARGETS_KEY,
			JSON.stringify(updated),
		);
	}

	async function handleSubmit() {
		if (await capNotInstalled()) {
			return;
		}

		if (!selectedTarget) {
			showToast({
				style: Toast.Style.Failure,
				title: "Please select a target",
			});
			return;
		}

		const captureMode =
			captureType === "screen"
				? { screen: selectedTarget }
				: { window: selectedTarget };

		await saveRecentTarget(captureType, selectedTarget);

		await executeCapAction(createTakeScreenshotAction(captureMode), {
			feedbackMessage: "📸 Screenshot taken",
			feedbackType: "hud",
		});
	}

	function handleOpenCap() {
		import("node:child_process").then(({ execFileSync }) => {
			execFileSync("open", [CAP_URL_SCHEME]);
		});
	}

	if (!isLoading && capNotRunning) {
		return (
			<EmptyState capNotRunning={capNotRunning} onOpenCap={handleOpenCap} />
		);
	}

	const allTargets = useMemo(() => {
		if (captureType === "screen") {
			return (devices?.screens ?? []).map((s) => ({
				name: s.name,
				value: s.name,
			}));
		}
		return (devices?.windows ?? []).map((w) => ({
			name: w.owner_name ? `${w.owner_name} — ${w.name}` : w.name,
			value: w.name,
		}));
	}, [captureType, devices]);

	const recentForCurrentType = recentTargets.filter(
		(r) => r.type === captureType && allTargets.some((t) => t.value === r.name),
	);

	return (
		<Form
			isLoading={isLoading}
			actions={
				<ActionPanel>
					<Action.SubmitForm
						title="Take Screenshot"
						icon={Icon.Camera}
						shortcut={{ modifiers: ["cmd"], key: "return" }}
						onSubmit={handleSubmit}
					/>
					<ActionPanel.Section title="Quick Actions">
						<Action
							title="Toggle Capture Type"
							icon={Icon.Switch}
							shortcut={{ modifiers: ["cmd"], key: "t" }}
							onAction={() => {
								const newType = captureType === "screen" ? "window" : "screen";
								setCaptureType(newType);
								const newTargets =
									newType === "screen"
										? (devices?.screens ?? [])
										: (devices?.windows ?? []);
								if (newTargets.length > 0) {
									setSelectedTarget(newTargets[0].name);
								}
							}}
						/>
					</ActionPanel.Section>
				</ActionPanel>
			}
		>
			<Form.Dropdown
				id="captureType"
				title="Capture Type"
				info="Capture a full screen or a specific application window"
				value={captureType}
				onChange={(v) => {
					setCaptureType(v as CaptureType);
					const newTargets =
						v === "screen"
							? (devices?.screens ?? [])
							: (devices?.windows ?? []);
					if (newTargets.length > 0) {
						setSelectedTarget(newTargets[0].name);
					} else {
						setSelectedTarget("");
					}
				}}
			>
				<Form.Dropdown.Item value="screen" title="Screen" icon={Icon.Desktop} />
				<Form.Dropdown.Item value="window" title="Window" icon={Icon.Window} />
			</Form.Dropdown>
			<Form.Dropdown
				id="target"
				title={captureType === "screen" ? "Screen" : "Window"}
				info="Capture a full screen or a specific application window"
				value={selectedTarget}
				onChange={setSelectedTarget}
			>
				{recentForCurrentType.length > 0 && (
					<Form.Dropdown.Section title="Recent">
						{recentForCurrentType.map((r) => (
							<Form.Dropdown.Item
								key={r.name}
								value={r.name}
								title={r.name}
								icon={Icon.Clock}
							/>
						))}
					</Form.Dropdown.Section>
				)}
				<Form.Dropdown.Section title="All">
					{allTargets.map((t) => (
						<Form.Dropdown.Item
							key={t.value}
							value={t.value}
							title={t.name}
							icon={t.value === selectedTarget ? Icon.CheckCircle : Icon.Dot}
						/>
					))}
				</Form.Dropdown.Section>
			</Form.Dropdown>
		</Form>
	);
}
