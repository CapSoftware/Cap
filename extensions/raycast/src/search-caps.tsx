import {
	Action,
	ActionPanel,
	Color,
	getPreferenceValues,
	Icon,
	List,
	open,
	showToast,
	Toast,
} from "@raycast/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CapRecordingItem, ExtensionPreferences } from "./types";
import {
	buildOpenEditorUrl,
	fetchCloudCaps,
	formatDuration,
	loadLocalRecordings,
	mergeRecordings,
	readCapDesktopStore,
	resolveDashboardUrl,
} from "./utils";

async function openProjectInCap(projectPath: string) {
	try {
		await open(buildOpenEditorUrl(projectPath, "cap-desktop"));
	} catch {
		await open(buildOpenEditorUrl(projectPath, "cap"));
	}
}

export default function Command() {
	const preferences = useMemo(
		() => getPreferenceValues<ExtensionPreferences>(),
		[],
	);
	const [items, setItems] = useState<CapRecordingItem[]>([]);
	const [isLoading, setIsLoading] = useState<boolean>(true);
	const [searchText, setSearchText] = useState<string>("");

	const refreshRecordings = useCallback(
		async (query?: string) => {
			setIsLoading(true);
			try {
				const store = readCapDesktopStore();
				const localItems = loadLocalRecordings(
					store,
					preferences.recordingsDirectory,
				);
				let cloudItems: CapRecordingItem[] = [];
				try {
					cloudItems = await fetchCloudCaps(preferences, query, store);
				} catch (error) {
					if (preferences.apiKey?.trim()) {
						const message =
							error instanceof Error
								? error.message
								: "Could not load cloud recordings.";
						await showToast({
							style: Toast.Style.Failure,
							title: "Cloud recordings unavailable",
							message,
						});
					}
				}
				const merged = mergeRecordings(localItems, cloudItems);
				setItems(merged);
			} finally {
				setIsLoading(false);
			}
		},
		[preferences],
	);

	useEffect(() => {
		void refreshRecordings();
	}, [refreshRecordings]);

	const filteredItems = useMemo(() => {
		const trimmed = searchText.trim().toLowerCase();
		if (!trimmed) {
			return items;
		}
		return items.filter(
			(item) =>
				item.title.toLowerCase().includes(trimmed) ||
				(item.shareUrl?.toLowerCase().includes(trimmed) ?? false) ||
				(item.projectPath?.toLowerCase().includes(trimmed) ?? false),
		);
	}, [items, searchText]);

	const dashboardUrl = useMemo(() => {
		try {
			return resolveDashboardUrl(preferences);
		} catch {
			return "https://cap.so/dashboard";
		}
	}, [preferences]);

	return (
		<List
			isLoading={isLoading}
			searchText={searchText}
			onSearchTextChange={setSearchText}
			searchBarPlaceholder="Search local and cloud Cap recordings..."
		>
			{filteredItems.length === 0 && !isLoading ? (
				<List.EmptyView
					icon={Icon.Video}
					title="No Cap Recordings Found"
					description="Start a recording with Cap or configure your Cap API key in preferences to browse cloud recordings."
					actions={
						<ActionPanel>
							<Action.OpenInBrowser
								title="Open Cap Dashboard"
								url={dashboardUrl}
							/>
							<Action
								title="Refresh Recordings"
								icon={Icon.ArrowClockwise}
								onAction={() => void refreshRecordings(searchText)}
							/>
						</ActionPanel>
					}
				/>
			) : (
				filteredItems.map((item) => {
					const accessories: List.Item.Accessory[] = [];
					const durationLabel = formatDuration(item.durationMs);
					if (durationLabel) {
						accessories.push({ text: durationLabel, icon: Icon.Clock });
					}
					accessories.push({
						tag: {
							value: item.mode === "studio" ? "Studio" : "Instant",
							color: item.mode === "studio" ? Color.Purple : Color.Blue,
						},
					});
					if (item.shareUrl) {
						accessories.push({
							tag: {
								value: "Shared",
								color: Color.Green,
							},
						});
					}
					if (item.createdAt) {
						const parsedDate = new Date(item.createdAt);
						if (!Number.isNaN(parsedDate.getTime())) {
							accessories.push({ date: parsedDate });
						}
					}

					return (
						<List.Item
							key={`${item.source}-${item.id}`}
							icon={item.mode === "studio" ? Icon.FilmStrip : Icon.Video}
							title={item.title}
							subtitle={item.shareUrl ?? item.projectPath}
							accessories={accessories}
							actions={
								<ActionPanel>
									{item.shareUrl ? (
										<>
											<Action.CopyToClipboard
												title="Copy Shareable Link"
												content={item.shareUrl}
											/>
											<Action.OpenInBrowser
												title="Open Share Link in Browser"
												url={item.shareUrl}
											/>
										</>
									) : null}
									{item.projectPath ? (
										<>
											<Action
												title={
													item.mode === "studio"
														? "Open in Cap Editor"
														: "Open Recording in Cap"
												}
												icon={Icon.Video}
												onAction={() =>
													void openProjectInCap(item.projectPath as string)
												}
											/>
											<Action.ShowInFinder path={item.projectPath} />
											<Action.CopyToClipboard
												title="Copy Local Project Path"
												content={item.projectPath}
											/>
										</>
									) : null}
									<Action.OpenInBrowser
										title="Open Cap Dashboard"
										url={dashboardUrl}
										shortcut={{ modifiers: ["cmd"], key: "d" }}
									/>
									<Action
										title="Refresh Recordings"
										icon={Icon.ArrowClockwise}
										shortcut={{ modifiers: ["cmd"], key: "r" }}
										onAction={() => void refreshRecordings(searchText)}
									/>
								</ActionPanel>
							}
						/>
					);
				})
			)}
		</List>
	);
}
