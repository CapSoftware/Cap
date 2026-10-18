import Constants from "expo-constants";
import { Image } from "expo-image";
import { router } from "expo-router";
import { type SFSymbol, SymbolView } from "expo-symbols";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	ActionSheetIOS,
	ActivityIndicator,
	Alert,
	Linking,
	Platform,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { apiBaseUrl, useAuth } from "@/auth/AuthContext";
import { SignInPanel } from "@/auth/SignInPanel";
import { getProPlan } from "@/billing/pro";
import { GlassSurface } from "@/components/GlassSurface";
import { OrgSwitcher } from "@/components/OrgSwitcher";
import { Screen } from "@/components/Screen";
import { colors, fonts, radius, squircle } from "@/theme";

type SettingsRowProps = {
	label: string;
	symbol: SFSymbol;
	onPress?: () => void;
	tintColor?: string;
	destructive?: boolean;
	value?: string;
	accessibilityValueText?: string;
	showChevron?: boolean;
	accessibilityHint?: string;
	busy?: boolean;
	disabled?: boolean;
};

function SettingsRow({
	label,
	symbol,
	onPress,
	tintColor = colors.gray12,
	destructive = false,
	value,
	accessibilityValueText,
	showChevron = true,
	accessibilityHint,
	busy = false,
	disabled = false,
}: SettingsRowProps) {
	const accessibilityValue = accessibilityValueText
		? { text: accessibilityValueText }
		: value
			? { text: value }
			: undefined;
	const isAction = Boolean(onPress);
	const isDisabled = disabled || busy;
	const content = (
		<>
			<View style={styles.settingsIcon}>
				{busy ? (
					<ActivityIndicator color={colors.gray9} size="small" />
				) : (
					<SymbolView
						name={symbol}
						size={18}
						tintColor={isDisabled ? colors.gray9 : tintColor}
						weight="semibold"
					/>
				)}
			</View>
			<Text
				style={[
					styles.settingsLabel,
					destructive && styles.dangerLabel,
					isDisabled && styles.settingsLabelDisabled,
				]}
			>
				{label}
			</Text>
			{value ? (
				<Text
					style={[
						styles.settingsValue,
						isDisabled && styles.settingsValueDisabled,
					]}
				>
					{value}
				</Text>
			) : null}
			{showChevron && isAction ? (
				<SymbolView
					name="chevron.right"
					size={13}
					tintColor={isDisabled ? colors.gray7 : colors.gray9}
					weight="semibold"
				/>
			) : null}
		</>
	);

	if (!onPress) {
		return (
			<View
				accessibilityLabel={label}
				accessibilityHint={accessibilityHint}
				accessibilityValue={accessibilityValue}
				style={styles.settingsRow}
			>
				{content}
			</View>
		);
	}

	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityHint={accessibilityHint}
			accessibilityState={{ busy, disabled: isDisabled }}
			accessibilityValue={accessibilityValue}
			disabled={isDisabled}
			onPress={onPress}
			style={({ pressed }) => [
				styles.settingsRow,
				isDisabled && styles.settingsRowDisabled,
				pressed && !isDisabled && styles.pressed,
			]}
		>
			{content}
		</Pressable>
	);
}

function SettingsSection({
	children,
	title,
}: {
	children: ReactNode;
	title: string;
}) {
	return (
		<View style={styles.section}>
			<Text style={styles.sectionTitle}>{title}</Text>
			<GlassSurface
				fallbackStyle={styles.settingsFallback}
				isInteractive
				style={styles.settingsGroup}
				tintColor={colors.gray1}
			>
				{children}
			</GlassSurface>
		</View>
	);
}

type AccountAction = "appSettings" | "refresh" | "signOut";

type PlanStatus = "loading" | "free" | "pro" | "error";

const openExternalPage = async (path: string) => {
	try {
		await Linking.openURL(new URL(path, apiBaseUrl).toString());
	} catch {
		Alert.alert("Unable to open page", "Check your connection and try again.");
	}
};

function PlanStatusButton({
	status,
	disabled,
	onRefresh,
}: {
	status: PlanStatus;
	disabled: boolean;
	onRefresh: () => void;
}) {
	if (status === "loading") {
		return (
			<View style={styles.planSection}>
				<Text style={styles.sectionTitle}>Plan</Text>
				<View
					accessibilityLabel="Checking Cap plan"
					accessibilityRole="summary"
					style={styles.planStatusButton}
				>
					<View pointerEvents="none" style={styles.planStatusInsetHighlight} />
					<View style={styles.planStatusIcon}>
						<ActivityIndicator color={colors.white} size="small" />
					</View>
					<View style={styles.planStatusText}>
						<Text style={styles.planStatusTitle}>Checking your plan...</Text>
					</View>
				</View>
			</View>
		);
	}

	if (status === "error") {
		return (
			<View style={styles.planSection}>
				<Text style={styles.sectionTitle}>Plan</Text>
				<Pressable
					accessibilityHint="Checks your Cap plan again"
					accessibilityLabel="Cap plan unavailable"
					accessibilityRole="button"
					accessibilityState={{ disabled }}
					disabled={disabled}
					onPress={onRefresh}
					style={({ pressed }) => [
						styles.planStatusButton,
						disabled && styles.planStatusButtonDisabled,
						pressed && !disabled && styles.planStatusButtonPressed,
					]}
				>
					<View pointerEvents="none" style={styles.planStatusInsetHighlight} />
					<View style={styles.planStatusIcon}>
						<SymbolView
							name="arrow.clockwise"
							size={18}
							tintColor={colors.white}
							weight="semibold"
						/>
					</View>
					<View style={styles.planStatusText}>
						<Text style={styles.planStatusTitle}>Plan unavailable</Text>
						<Text style={styles.planStatusDetail}>Tap to try again</Text>
					</View>
					<SymbolView
						name="chevron.right"
						size={14}
						tintColor={colors.white}
						weight="semibold"
					/>
				</Pressable>
			</View>
		);
	}

	const isPro = status === "pro";

	const content = (
		<>
			<View pointerEvents="none" style={styles.planStatusInsetHighlight} />
			<View style={styles.planStatusIcon}>
				<SymbolView
					name={isPro ? "checkmark" : "sparkles"}
					size={18}
					tintColor={colors.white}
					weight="semibold"
				/>
			</View>
			<View style={styles.planStatusText}>
				<Text style={styles.planStatusTitle}>
					{isPro ? "Cap Pro" : "Free plan"}
				</Text>
				<Text style={styles.planStatusDetail}>
					{isPro
						? "Unlimited recording time"
						: "Free plan · Recordings are limited to 5 minutes"}
				</Text>
			</View>
		</>
	);

	return (
		<View style={styles.planSection}>
			<Text style={styles.sectionTitle}>Plan</Text>
			<View
				accessibilityLabel={`Cap plan: ${isPro ? "Cap Pro" : "Free"}`}
				accessibilityRole="summary"
				accessibilityValue={{
					text: isPro
						? "Cap Pro. Unlimited recording time"
						: "Free plan. Recordings are limited to 5 minutes",
				}}
				style={styles.planStatusButton}
			>
				{content}
			</View>
		</View>
	);
}

export default function AccountScreen() {
	const auth = useAuth();
	const appVersion = Constants.expoConfig?.version ?? "1.0.0";
	const [accountAction, setAccountAction] = useState<AccountAction | null>(
		null,
	);
	const [planStatus, setPlanStatus] = useState<PlanStatus>("loading");
	const accountActionRef = useRef<AccountAction | null>(null);
	const accountActionHint =
		accountAction === "refresh"
			? "Refresh is in progress"
			: accountAction === "signOut"
				? "Sign out is in progress"
				: accountAction !== null
					? "Settings are opening"
					: null;
	const accountActionDisabled = accountAction !== null;

	const refreshPlan = useCallback(async () => {
		if (!auth.apiKey) return;
		setPlanStatus("loading");
		try {
			const input = { apiKey: auth.apiKey, baseUrl: apiBaseUrl };
			const plan = await getProPlan(input);
			setPlanStatus(plan.upgraded ? "pro" : "free");
		} catch {
			setPlanStatus("error");
		}
	}, [auth.apiKey]);

	useEffect(() => {
		if (auth.status !== "signedIn" || !auth.apiKey) return;
		void refreshPlan();
	}, [auth.apiKey, auth.status, refreshPlan]);

	const runAccountAction = async (
		action: AccountAction,
		operation: () => Promise<unknown>,
	) => {
		if (accountActionRef.current !== null) return;
		accountActionRef.current = action;
		setAccountAction(action);
		try {
			await operation();
		} finally {
			accountActionRef.current = null;
			setAccountAction(null);
		}
	};

	const confirmSignOut = () => {
		if (accountActionRef.current !== null) return;

		if (Platform.OS === "ios") {
			ActionSheetIOS.showActionSheetWithOptions(
				{
					cancelButtonIndex: 1,
					destructiveButtonIndex: 0,
					message: "Remove this Cap session from your device?",
					options: ["Sign out", "Cancel"],
					title: "Sign out",
					tintColor: colors.blue11,
					userInterfaceStyle: "light",
				},
				(index) => {
					if (index === 0) {
						void runAccountAction("signOut", auth.signOut);
					}
				},
			);
			return;
		}

		Alert.alert("Sign out", "Remove this Cap session from your device?", [
			{ text: "Cancel", style: "cancel" },
			{
				text: "Sign out",
				style: "destructive",
				onPress: () => {
					void runAccountAction("signOut", auth.signOut);
				},
			},
		]);
	};

	if (auth.status === "loading") {
		return <Screen title="Account" loading />;
	}

	if (auth.status === "signedOut") {
		return (
			<Screen scroll>
				<SignInPanel title="Sign in to Cap" />
			</Screen>
		);
	}
	return (
		<Screen
			title="Account"
			subtitle={auth.bootstrap?.user.email ?? null}
			scroll
			contentInsetBottom={112}
		>
			{auth.bootstrap ? (
				<GlassSurface
					fallbackStyle={styles.cardFallback}
					isInteractive
					style={styles.card}
					tintColor={colors.gray1}
				>
					<View style={styles.identityRow}>
						<View style={styles.avatar}>
							{auth.bootstrap.user.imageUrl ? (
								<Image
									source={{ uri: auth.bootstrap.user.imageUrl }}
									style={styles.avatarImage}
								/>
							) : (
								<Text style={styles.avatarText}>
									{(auth.bootstrap.user.name ?? auth.bootstrap.user.email)
										.slice(0, 1)
										.toUpperCase()}
								</Text>
							)}
						</View>
						<View style={styles.identityText}>
							<Text numberOfLines={1} style={styles.name}>
								{[auth.bootstrap.user.name, auth.bootstrap.user.lastName]
									.filter(Boolean)
									.join(" ") || "Cap user"}
							</Text>
							<Text numberOfLines={1} style={styles.email}>
								{auth.bootstrap.user.email}
							</Text>
						</View>
					</View>
					<OrgSwitcher
						bootstrap={auth.bootstrap}
						onChange={auth.setActiveOrganization}
					/>
				</GlassSurface>
			) : null}
			<SettingsSection title="Profile">
				<SettingsRow
					accessibilityHint="Opens native profile settings"
					disabled={accountActionDisabled}
					label="Name and Profile Image"
					symbol="person.crop.circle"
					onPress={() => router.push("/profile-settings")}
					value={
						auth.bootstrap
							? [auth.bootstrap.user.name, auth.bootstrap.user.lastName]
									.filter(Boolean)
									.join(" ") || undefined
							: undefined
					}
				/>
			</SettingsSection>
			<PlanStatusButton
				disabled={accountActionDisabled}
				onRefresh={() => {
					void refreshPlan();
				}}
				status={planStatus}
			/>
			<SettingsSection title="Organization">
				<SettingsRow
					accessibilityHint={
						accountActionHint ?? "Opens native organization settings"
					}
					disabled={accountActionDisabled}
					label="Organization Settings"
					symbol="building.2"
					onPress={() => router.push("/organization-settings")}
				/>
			</SettingsSection>
			<SettingsSection title="App">
				<SettingsRow
					accessibilityValueText={
						accountAction === "refresh" ? "Refreshing account data" : undefined
					}
					accessibilityHint={accountActionHint ?? "Refreshes account data"}
					busy={accountAction === "refresh"}
					disabled={accountActionDisabled}
					label="Refresh"
					symbol="arrow.clockwise"
					onPress={() => {
						void runAccountAction("refresh", () =>
							Promise.all([auth.refresh(), refreshPlan()]),
						);
					}}
					value={accountAction === "refresh" ? "Refreshing..." : undefined}
				/>
				<View style={styles.separator} />
				<SettingsRow
					accessibilityValueText={
						accountAction === "appSettings"
							? "Opening iOS app settings"
							: undefined
					}
					accessibilityHint={accountActionHint ?? "Opens iOS app settings"}
					busy={accountAction === "appSettings"}
					disabled={accountActionDisabled}
					label="App Settings"
					symbol="gearshape"
					onPress={() => {
						void runAccountAction("appSettings", Linking.openSettings);
					}}
					value={accountAction === "appSettings" ? "Opening..." : undefined}
				/>
				<View style={styles.separator} />
				<SettingsRow
					label="Version"
					symbol="info.circle"
					value={appVersion}
					showChevron={false}
				/>
			</SettingsSection>
			<SettingsSection title="Session">
				<SettingsRow
					accessibilityValueText={
						accountAction === "signOut" ? "Signing out of Cap" : undefined
					}
					accessibilityHint={accountActionHint ?? "Signs out of this device"}
					busy={accountAction === "signOut"}
					disabled={accountActionDisabled}
					label="Sign out"
					symbol="rectangle.portrait.and.arrow.right"
					onPress={confirmSignOut}
					showChevron={false}
					tintColor={colors.red9}
					destructive
					value={accountAction === "signOut" ? "Signing out..." : undefined}
				/>
			</SettingsSection>
			<SettingsSection title="Help & Legal">
				<SettingsRow
					accessibilityHint="Opens Cap help and support"
					disabled={accountActionDisabled}
					label="Help & Support"
					symbol="questionmark.circle"
					onPress={() => {
						void openExternalPage("/docs");
					}}
				/>
				<View style={styles.separator} />
				<SettingsRow
					accessibilityHint="Opens the Cap privacy policy"
					disabled={accountActionDisabled}
					label="Privacy Policy"
					symbol="hand.raised"
					onPress={() => {
						void openExternalPage("/privacy");
					}}
				/>
				<View style={styles.separator} />
				<SettingsRow
					accessibilityHint="Opens the Cap terms of service"
					disabled={accountActionDisabled}
					label="Terms of Service"
					symbol="doc.text"
					onPress={() => {
						void openExternalPage("/terms");
					}}
				/>
			</SettingsSection>
			<SettingsSection title="Danger Zone">
				<SettingsRow
					accessibilityHint="Opens permanent account deletion"
					disabled={accountActionDisabled}
					label="Delete account"
					symbol="trash"
					onPress={() => router.push("/delete-account")}
					tintColor={colors.red9}
					destructive
				/>
			</SettingsSection>
		</Screen>
	);
}

const styles = StyleSheet.create({
	planSection: {
		marginTop: 16,
		gap: 8,
	},
	planStatusButton: {
		minHeight: 68,
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		borderRadius: radius.full,
		borderWidth: 1,
		borderColor: colors.buttonBlueBorder,
		backgroundColor: colors.buttonBlue,
		paddingHorizontal: 16,
		paddingVertical: 12,
		...squircle,
	},
	planStatusInsetHighlight: {
		position: "absolute",
		top: 0,
		left: 0,
		right: 0,
		height: 1.5,
		backgroundColor: "rgba(255, 255, 255, 0.4)",
	},
	planStatusButtonPressed: {
		backgroundColor: colors.buttonBlueHover,
	},
	planStatusButtonDisabled: {
		borderColor: colors.gray8,
		backgroundColor: colors.gray7,
	},
	planStatusIcon: {
		width: 34,
		height: 34,
		borderRadius: radius.full,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "rgba(255, 255, 255, 0.16)",
		...squircle,
	},
	planStatusText: {
		flex: 1,
		minWidth: 0,
		gap: 1,
	},
	planStatusTitle: {
		fontFamily: fonts.bold,
		fontSize: 16,
		lineHeight: 20,
		color: colors.white,
	},
	planStatusDetail: {
		fontFamily: fonts.regular,
		fontSize: 13,
		lineHeight: 17,
		color: "rgba(255, 255, 255, 0.82)",
	},
	card: {
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		padding: 16,
		gap: 16,
		...squircle,
	},
	cardFallback: {
		backgroundColor: colors.gray1,
	},
	identityRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
	},
	avatar: {
		width: 48,
		height: 48,
		borderRadius: radius.sm,
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
		fontSize: 18,
		color: colors.blue11,
	},
	identityText: {
		flex: 1,
		minWidth: 0,
	},
	name: {
		fontFamily: fonts.medium,
		fontSize: 19,
		color: colors.gray12,
	},
	email: {
		fontFamily: fonts.regular,
		fontSize: 14,
		color: colors.gray10,
		marginTop: 2,
	},
	settingsGroup: {
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		overflow: "hidden",
		...squircle,
	},
	section: {
		marginTop: 16,
		gap: 8,
	},
	sectionTitle: {
		fontFamily: fonts.medium,
		fontSize: 13,
		lineHeight: 18,
		color: colors.gray10,
		paddingHorizontal: 4,
	},
	settingsFallback: {
		backgroundColor: colors.gray1,
	},
	settingsRow: {
		minHeight: 54,
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingHorizontal: 14,
	},
	settingsRowDisabled: {
		backgroundColor: colors.gray2,
	},
	pressed: {
		backgroundColor: colors.gray3,
	},
	settingsIcon: {
		width: 30,
		height: 30,
		borderRadius: radius.sm,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.gray3,
		...squircle,
	},
	settingsLabel: {
		flex: 1,
		fontFamily: fonts.medium,
		fontSize: 16,
		color: colors.gray12,
	},
	settingsLabelDisabled: {
		color: colors.gray9,
	},
	settingsValue: {
		fontFamily: fonts.regular,
		fontSize: 15,
		color: colors.gray10,
	},
	settingsValueDisabled: {
		color: colors.gray9,
	},
	dangerLabel: {
		color: colors.red9,
	},
	separator: {
		height: StyleSheet.hairlineWidth,
		backgroundColor: colors.gray4,
		marginLeft: 56,
	},
});
