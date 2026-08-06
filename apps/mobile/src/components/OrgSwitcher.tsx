import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import {
	ActionSheetIOS,
	Modal,
	Platform,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import type { MobileBootstrapResponse } from "@/api/mobile";
import { colors, fonts, radius, shadows, squircle } from "@/theme";

type OrgSwitcherProps = {
	bootstrap: MobileBootstrapResponse;
	onChange: (organizationId: string) => Promise<void>;
};

type Organization = MobileBootstrapResponse["organizations"][number];

const formatRole = (role: Organization["role"]) =>
	role.slice(0, 1).toUpperCase() + role.slice(1);

function OrgAvatar({ organization }: { organization: Organization }) {
	return (
		<View style={styles.avatar}>
			{organization.iconUrl ? (
				<Image
					source={{ uri: organization.iconUrl }}
					style={styles.avatarImage}
				/>
			) : (
				<Text style={styles.avatarText}>
					{organization.name.slice(0, 1).toUpperCase()}
				</Text>
			)}
		</View>
	);
}

export function OrgSwitcher({ bootstrap, onChange }: OrgSwitcherProps) {
	const [open, setOpen] = useState(false);
	const activeOrganization =
		bootstrap.organizations.find(
			(org) => org.id === bootstrap.activeOrganizationId,
		) ?? bootstrap.organizations[0];

	if (!activeOrganization) return null;

	const openSwitcher = () => {
		if (Platform.OS === "ios") {
			const activeIndex = bootstrap.organizations.findIndex(
				(organization) => organization.id === activeOrganization.id,
			);
			const options = [
				...bootstrap.organizations.map(
					(organization) =>
						`${organization.name} (${formatRole(organization.role)})`,
				),
				"Cancel",
			];
			ActionSheetIOS.showActionSheetWithOptions(
				{
					cancelButtonIndex: options.length - 1,
					disabledButtonIndices: activeIndex >= 0 ? [activeIndex] : undefined,
					disabledButtonTintColor: colors.gray9,
					message: activeOrganization.name,
					options,
					title: "Organization",
					tintColor: colors.blue11,
					userInterfaceStyle: "light",
				},
				(index) => {
					const organization = bootstrap.organizations[index];
					if (organization && organization.id !== activeOrganization.id) {
						void onChange(organization.id);
					}
				},
			);
			return;
		}
		setOpen(true);
	};

	return (
		<>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel="Switch organization"
				onPress={openSwitcher}
				style={({ pressed }) => [
					styles.trigger,
					pressed && styles.triggerPressed,
				]}
			>
				<OrgAvatar organization={activeOrganization} />
				<Text numberOfLines={1} style={styles.triggerText}>
					{activeOrganization.name}
				</Text>
				<SymbolView
					name="chevron.down"
					size={16}
					tintColor={colors.gray11}
					weight="medium"
				/>
			</Pressable>
			<Modal
				allowSwipeDismissal
				animationType="fade"
				onRequestClose={() => setOpen(false)}
				presentationStyle="overFullScreen"
				transparent
				visible={open}
			>
				<Pressable style={styles.overlay} onPress={() => setOpen(false)}>
					<Pressable style={styles.sheet}>
						<Text style={styles.sheetTitle}>Organization</Text>
						{bootstrap.organizations.map((org) => {
							const active = org.id === activeOrganization.id;
							return (
								<Pressable
									key={org.id}
									accessibilityRole="button"
									accessibilityState={{ selected: active }}
									onPress={async () => {
										setOpen(false);
										if (!active) await onChange(org.id);
									}}
									style={styles.orgRow}
								>
									<OrgAvatar organization={org} />
									<View style={styles.orgTextWrap}>
										<Text numberOfLines={1} style={styles.orgName}>
											{org.name}
										</Text>
										<Text style={styles.orgRole}>{org.role}</Text>
									</View>
									{active ? (
										<SymbolView
											name="checkmark"
											size={18}
											tintColor={colors.blue9}
											weight="semibold"
										/>
									) : null}
								</Pressable>
							);
						})}
					</Pressable>
				</Pressable>
			</Modal>
		</>
	);
}

const styles = StyleSheet.create({
	trigger: {
		height: 44,
		flexDirection: "row",
		alignItems: "center",
		gap: 9,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray5,
		backgroundColor: colors.gray1,
		borderRadius: radius.full,
		paddingHorizontal: 10,
		...squircle,
	},
	triggerPressed: {
		backgroundColor: colors.gray3,
		borderColor: colors.gray6,
	},
	triggerText: {
		flex: 1,
		fontFamily: fonts.medium,
		color: colors.gray12,
		fontSize: 15,
	},
	avatar: {
		width: 26,
		height: 26,
		borderRadius: radius.xs,
		overflow: "hidden",
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.blue3,
		...squircle,
	},
	avatarImage: {
		width: "100%",
		height: "100%",
	},
	avatarText: {
		fontFamily: fonts.medium,
		fontSize: 12,
		color: colors.blue11,
	},
	overlay: {
		flex: 1,
		backgroundColor: colors.blackAlpha40,
		justifyContent: "flex-end",
	},
	sheet: {
		backgroundColor: colors.gray1,
		borderTopLeftRadius: radius.xl,
		borderTopRightRadius: radius.xl,
		padding: 18,
		paddingBottom: 32,
		gap: 6,
		...shadows.popover,
		...squircle,
	},
	sheetTitle: {
		fontFamily: fonts.medium,
		fontSize: 20,
		lineHeight: 26,
		color: colors.gray12,
		marginBottom: 6,
	},
	orgRow: {
		minHeight: 58,
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		borderRadius: radius.sm,
		paddingHorizontal: 8,
		...squircle,
	},
	orgTextWrap: {
		flex: 1,
		minWidth: 0,
	},
	orgName: {
		fontFamily: fonts.medium,
		fontSize: 16,
		color: colors.gray12,
	},
	orgRole: {
		fontFamily: fonts.regular,
		fontSize: 12,
		color: colors.gray10,
		textTransform: "capitalize",
	},
});
