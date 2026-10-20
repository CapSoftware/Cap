import { type SFSymbol, SymbolView } from "expo-symbols";
import type { ReactNode } from "react";
import {
	Modal,
	Pressable,
	ScrollView,
	StyleSheet,
	Switch,
	Text,
	View,
} from "react-native";
import type { MobileCapSummary } from "@/api/mobile";
import { GlassSurface } from "@/components/GlassSurface";
import { colors, fonts, radius, squircle } from "@/theme";

type CapSettingsSheetProps = {
	cap: MobileCapSummary | null;
	visible: boolean;
	onClose: () => void;
	onCopyLink: (cap: MobileCapSummary) => void;
	onShareLink: (cap: MobileCapSummary) => void;
	onRename: (cap: MobileCapSummary) => void;
	onPassword: (cap: MobileCapSummary) => void;
	onViewAnalytics?: (cap: MobileCapSummary) => void;
	onVisibilityChange: (cap: MobileCapSummary, isPublic: boolean) => void;
	onSaveVideo: (cap: MobileCapSummary) => void;
	onDelete: (cap: MobileCapSummary) => void;
	visibilityDisabled?: boolean;
	visibilityDisabledHint?: string;
	visibilityDisabledValue?: string;
	visibilityDisabledAccessibilityValue?: string;
	saveDisabled?: boolean;
	saveDisabledHint?: string;
	saveDisabledValue?: string;
	saveDisabledAccessibilityValue?: string;
};

type SettingsRowProps = {
	label: string;
	value?: string;
	accessibilityValueText?: string;
	symbol: SFSymbol;
	accessibilityHint?: string;
	danger?: boolean;
	disabled?: boolean;
	onPress?: () => void;
	children?: ReactNode;
};

function SettingsRow({
	label,
	value,
	accessibilityValueText,
	symbol,
	accessibilityHint,
	danger = false,
	disabled = false,
	onPress,
	children,
}: SettingsRowProps) {
	const accessibilityValue = accessibilityValueText
		? { text: accessibilityValueText }
		: value
			? { text: value }
			: undefined;
	const isAction = Boolean(onPress) || disabled;
	const content = (
		<>
			<View
				style={[
					styles.rowIcon,
					danger ? styles.dangerIcon : null,
					disabled ? styles.rowIconDisabled : null,
				]}
			>
				<SymbolView
					name={symbol}
					size={16}
					tintColor={
						disabled ? colors.gray9 : danger ? colors.red11 : colors.gray11
					}
					weight="medium"
				/>
			</View>
			<Text
				numberOfLines={1}
				style={[
					styles.rowLabel,
					danger ? styles.dangerText : null,
					disabled ? styles.rowLabelDisabled : null,
				]}
			>
				{label}
			</Text>
			{value ? (
				<Text
					numberOfLines={1}
					style={[styles.rowValue, disabled ? styles.rowValueDisabled : null]}
				>
					{value}
				</Text>
			) : null}
			{children}
			{isAction ? (
				<SymbolView
					name="chevron.right"
					size={12}
					tintColor={disabled ? colors.gray7 : colors.gray9}
					weight="semibold"
				/>
			) : null}
		</>
	);

	if (!isAction) {
		return (
			<View
				accessibilityLabel={label}
				accessibilityHint={accessibilityHint}
				accessibilityValue={accessibilityValue}
				style={styles.row}
			>
				{content}
			</View>
		);
	}

	return (
		<Pressable
			accessibilityLabel={label}
			accessibilityHint={accessibilityHint}
			accessibilityRole="button"
			accessibilityState={disabled ? { disabled: true } : undefined}
			accessibilityValue={accessibilityValue}
			disabled={disabled}
			onPress={onPress}
			style={({ pressed }) => [
				styles.row,
				pressed && !disabled ? styles.rowPressed : null,
				disabled ? styles.rowDisabled : null,
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
				fallbackStyle={styles.groupFallback}
				isInteractive
				style={styles.group}
				tintColor={colors.gray1}
			>
				{children}
			</GlassSurface>
		</View>
	);
}

export function CapSettingsSheet({
	cap,
	visible,
	onClose,
	onCopyLink,
	onShareLink,
	onRename,
	onPassword,
	onViewAnalytics,
	onVisibilityChange,
	onSaveVideo,
	onDelete,
	visibilityDisabled = false,
	visibilityDisabledHint,
	visibilityDisabledValue,
	visibilityDisabledAccessibilityValue,
	saveDisabled = false,
	saveDisabledHint,
	saveDisabledValue,
	saveDisabledAccessibilityValue,
}: CapSettingsSheetProps) {
	if (!cap) return null;

	return (
		<Modal
			allowSwipeDismissal
			animationType="slide"
			onRequestClose={onClose}
			presentationStyle="formSheet"
			visible={visible}
		>
			<ScrollView
				contentContainerStyle={styles.sheetContent}
				showsVerticalScrollIndicator={false}
				style={styles.sheet}
			>
				<View style={styles.header}>
					<View style={styles.headerCopy}>
						<Text style={styles.eyebrow}>Settings</Text>
						<Text numberOfLines={1} style={styles.title}>
							{cap.title}
						</Text>
						<Text numberOfLines={1} style={styles.shareUrl}>
							{cap.shareUrl}
						</Text>
					</View>
					<Pressable
						accessibilityLabel="Close Cap settings"
						accessibilityHint="Dismisses Cap settings"
						accessibilityRole="button"
						hitSlop={8}
						onPress={onClose}
						style={({ pressed }) => [
							styles.closeButton,
							pressed ? styles.closeButtonPressed : null,
						]}
					>
						<SymbolView
							name="xmark"
							size={14}
							tintColor={colors.gray12}
							weight="semibold"
						/>
					</Pressable>
				</View>

				<SettingsSection title="Details">
					<SettingsRow
						accessibilityHint="Renames this Cap"
						label="Title"
						onPress={() => onRename(cap)}
						symbol="textformat"
						value={cap.title}
					/>
					{onViewAnalytics ? (
						<>
							<View style={styles.separator} />
							<SettingsRow
								accessibilityHint="Opens native analytics"
								label="View analytics"
								onPress={() => onViewAnalytics(cap)}
								symbol="chart.bar"
							/>
						</>
					) : null}
				</SettingsSection>

				<SettingsSection title="Share">
					<SettingsRow
						accessibilityValueText={visibilityDisabledAccessibilityValue}
						label="Public link"
						symbol="link"
						value={visibilityDisabledValue}
					>
						<Switch
							accessibilityHint={
								visibilityDisabled
									? (visibilityDisabledHint ?? "Sharing update is in progress")
									: "Toggles public link sharing"
							}
							accessibilityLabel="Public link"
							accessibilityRole="switch"
							accessibilityState={{
								checked: cap.public,
								disabled: visibilityDisabled,
							}}
							disabled={visibilityDisabled}
							ios_backgroundColor={colors.gray5}
							onValueChange={(value) => onVisibilityChange(cap, value)}
							trackColor={{ false: colors.gray5, true: colors.blue7 }}
							thumbColor={colors.white}
							value={cap.public}
						/>
					</SettingsRow>
					<View style={styles.separator} />
					<SettingsRow
						accessibilityHint="Opens password settings"
						label="Password"
						onPress={() => onPassword(cap)}
						symbol={cap.protected ? "lock.fill" : "lock.open"}
						value={cap.protected ? "Protected" : "Off"}
					/>
				</SettingsSection>

				<SettingsSection title="Actions">
					<SettingsRow
						accessibilityHint="Copies this Cap link"
						label="Copy link"
						onPress={() => onCopyLink(cap)}
						symbol="doc.on.doc"
					/>
					<View style={styles.separator} />
					<SettingsRow
						accessibilityHint="Opens the native share sheet"
						label="Share"
						onPress={() => onShareLink(cap)}
						symbol="square.and.arrow.up"
					/>
					<View style={styles.separator} />
					<SettingsRow
						accessibilityHint={
							saveDisabled
								? (saveDisabledHint ?? "Save is in progress")
								: "Saves this video to Photos"
						}
						disabled={saveDisabled}
						label="Save video"
						onPress={() => onSaveVideo(cap)}
						symbol="square.and.arrow.down"
						accessibilityValueText={saveDisabledAccessibilityValue}
						value={saveDisabled ? saveDisabledValue : undefined}
					/>
				</SettingsSection>

				<SettingsSection title="Danger Zone">
					<SettingsRow
						accessibilityHint="Deletes this Cap"
						danger
						label="Delete Cap"
						onPress={() => onDelete(cap)}
						symbol="trash"
					/>
				</SettingsSection>
			</ScrollView>
		</Modal>
	);
}

const styles = StyleSheet.create({
	sheet: {
		flex: 1,
		backgroundColor: colors.appBackground,
	},
	sheetContent: {
		paddingHorizontal: 20,
		paddingTop: 20,
		paddingBottom: 28,
	},
	header: {
		flexDirection: "row",
		alignItems: "flex-start",
		gap: 16,
		paddingTop: 8,
		paddingBottom: 18,
	},
	headerCopy: {
		flex: 1,
		minWidth: 0,
	},
	eyebrow: {
		fontFamily: fonts.medium,
		fontSize: 13,
		lineHeight: 18,
		color: colors.gray10,
		marginBottom: 4,
	},
	title: {
		fontFamily: fonts.medium,
		fontSize: 24,
		lineHeight: 30,
		color: colors.gray12,
	},
	shareUrl: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.gray10,
		marginTop: 4,
	},
	closeButton: {
		width: 34,
		height: 34,
		borderRadius: radius.full,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.gray3,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray5,
		...squircle,
	},
	closeButtonPressed: {
		backgroundColor: colors.gray5,
	},
	section: {
		gap: 8,
		marginBottom: 18,
	},
	sectionTitle: {
		fontFamily: fonts.medium,
		fontSize: 13,
		lineHeight: 18,
		color: colors.gray10,
		paddingHorizontal: 4,
	},
	group: {
		overflow: "hidden",
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		...squircle,
	},
	groupFallback: {
		backgroundColor: colors.gray1,
	},
	row: {
		minHeight: 54,
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingHorizontal: 14,
		paddingVertical: 10,
	},
	rowPressed: {
		backgroundColor: colors.gray2,
	},
	rowDisabled: {
		backgroundColor: colors.gray2,
	},
	rowIcon: {
		width: 28,
		height: 28,
		borderRadius: radius.sm,
		backgroundColor: colors.gray3,
		alignItems: "center",
		justifyContent: "center",
		...squircle,
	},
	dangerIcon: {
		backgroundColor: colors.red3,
	},
	rowIconDisabled: {
		backgroundColor: colors.gray3,
	},
	rowLabel: {
		flex: 1,
		fontFamily: fonts.regular,
		fontSize: 16,
		lineHeight: 22,
		color: colors.gray12,
	},
	rowValue: {
		maxWidth: "42%",
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.gray10,
	},
	rowLabelDisabled: {
		color: colors.gray9,
	},
	rowValueDisabled: {
		color: colors.gray9,
	},
	dangerText: {
		color: colors.red11,
	},
	separator: {
		height: StyleSheet.hairlineWidth,
		backgroundColor: colors.gray3,
		marginLeft: 54,
	},
});
