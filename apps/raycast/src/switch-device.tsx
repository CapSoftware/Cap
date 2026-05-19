import { Action, ActionPanel, List, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { openCapDeeplink } from "./lib/deeplinks";
import { type DeviceItem, loadDeviceItems } from "./lib/devices";

export default function Command() {
	const [items, setItems] = useState<DeviceItem[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;

		async function load() {
			try {
				const nextItems = await loadDeviceItems();
				if (!cancelled) {
					setItems(nextItems);
					setError(null);
				}
			} catch (loadError) {
				const message =
					loadError instanceof Error ? loadError.message : String(loadError);
				if (!cancelled) {
					setItems([]);
					setError(message);
				}
				await showToast({
					style: Toast.Style.Failure,
					title: "Failed to enumerate devices",
					message,
				});
			} finally {
				if (!cancelled) {
					setIsLoading(false);
				}
			}
		}

		void load();

		return () => {
			cancelled = true;
		};
	}, []);

	const microphones = items.filter((item) => item.section === "Microphones");
	const cameras = items.filter((item) => item.section === "Cameras");

	return (
		<List isLoading={isLoading} searchBarPlaceholder="Switch Cap devices">
			{error ? (
				<List.EmptyView
					title="Unable to read system devices"
					description={error}
				/>
			) : null}
			<List.Section title="Microphones">
				{microphones.map((item) => (
					<List.Item
						key={item.key}
						title={item.title}
						subtitle={item.subtitle}
						actions={
							<ActionPanel>
								<Action
									title="Send Deeplink"
									onAction={() =>
										void openCapDeeplink(item.url, `Sent ${item.title} to Cap`)
									}
								/>
								<Action.CopyToClipboard
									title="Copy Deeplink"
									content={item.url}
								/>
							</ActionPanel>
						}
					/>
				))}
			</List.Section>
			<List.Section title="Cameras">
				{cameras.map((item) => (
					<List.Item
						key={item.key}
						title={item.title}
						subtitle={item.subtitle}
						actions={
							<ActionPanel>
								<Action
									title="Send Deeplink"
									onAction={() =>
										void openCapDeeplink(item.url, `Sent ${item.title} to Cap`)
									}
								/>
								<Action.CopyToClipboard
									title="Copy Deeplink"
									content={item.url}
								/>
							</ActionPanel>
						}
					/>
				))}
			</List.Section>
		</List>
	);
}
