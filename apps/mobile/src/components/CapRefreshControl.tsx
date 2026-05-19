import { RefreshControl } from "react-native";
import { colors } from "@/theme";

type CapRefreshControlProps = {
	refreshing: boolean;
	onRefresh: () => void;
};

export function CapRefreshControl({
	refreshing,
	onRefresh,
}: CapRefreshControlProps) {
	return (
		<RefreshControl
			colors={[colors.blue11]}
			onRefresh={onRefresh}
			progressBackgroundColor={colors.gray1}
			refreshing={refreshing}
			tintColor={colors.blue11}
		/>
	);
}
