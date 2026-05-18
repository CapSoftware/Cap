import { Action, ActionPanel, List } from "@raycast/api";
import { capControlActions, openCapDeeplink } from "./lib/deeplinks";

export default function Command() {
	return (
		<List searchBarPlaceholder="Control Cap recordings">
			{capControlActions.map((action) => (
				<List.Item
					key={action.key}
					title={action.title}
					subtitle={action.subtitle}
					actions={
						<ActionPanel>
							<Action
								title="Send Deeplink"
								onAction={() =>
									void openCapDeeplink(action.url, action.successTitle)
								}
							/>
							<Action.CopyToClipboard
								title="Copy Deeplink"
								content={action.url}
							/>
						</ActionPanel>
					}
				/>
			))}
		</List>
	);
}
