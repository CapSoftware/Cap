import { NativeTabs } from "expo-router/unstable-native-tabs";
import { colors, fonts } from "@/theme";

export default function TabsLayout() {
	return (
		<NativeTabs
			backgroundColor={colors.glass}
			blurEffect="systemMaterialLight"
			disableTransparentOnScrollEdge
			iconColor={{ default: colors.gray9, selected: colors.blue9 }}
			labelStyle={{
				default: {
					color: colors.gray9,
					fontFamily: fonts.medium,
					fontSize: 11,
				},
				selected: {
					color: colors.blue9,
					fontFamily: fonts.medium,
					fontSize: 11,
				},
			}}
			minimizeBehavior="automatic"
			shadowColor={colors.gray4}
			tintColor={colors.blue9}
		>
			<NativeTabs.Trigger name="index">
				<NativeTabs.Trigger.Label>My Caps</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon
					sf={{ default: "folder", selected: "folder.fill" }}
				/>
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="upload">
				<NativeTabs.Trigger.Label>Import</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon
					sf={{
						default: "square.and.arrow.up",
						selected: "square.and.arrow.up.fill",
					}}
				/>
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="account">
				<NativeTabs.Trigger.Label>Account</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon
					sf={{
						default: "person.crop.circle",
						selected: "person.crop.circle.fill",
					}}
				/>
			</NativeTabs.Trigger>
		</NativeTabs>
	);
}
