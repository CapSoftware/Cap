import { Action, ActionPanel, List } from "@raycast/api";
import { recordingActions, runCapAction } from "./lib/deeplinks";

export default function Command() {
	return (
		<List>
			{recordingActions.map((item) => (
				<List.Item
					key={item.title}
					title={item.title}
					actions={
						<ActionPanel>
							<Action
								title={item.title}
								onAction={() => runCapAction(item.action, item.title)}
							/>
						</ActionPanel>
					}
				/>
			))}
		</List>
	);
}
