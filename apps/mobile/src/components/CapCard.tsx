import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import Svg, { Circle } from "react-native-svg";
import type { MobileCapSummary } from "@/api/mobile";
import { colors, fonts, radius, squircle } from "@/theme";
import { getCapCardViewModel } from "./capCardViewModel";

type CapCardProps = {
	cap: MobileCapSummary;
	onPress: () => void;
	onCopyPress?: () => void;
	onSharePress?: () => void;
	onVisibilityPress?: () => void;
	onAnalyticsPress?: () => void;
	onMenuPress?: () => void;
	visibilityBusy?: boolean;
	visibilityDisabled?: boolean;
	visibilityDisabledHint?: string;
	visibilityValue?: string;
	visibilityAccessibilityValue?: string;
	now?: Date;
};

const progressSize = 18;
const progressStrokeWidth = 3;
const progressRadius = (progressSize - progressStrokeWidth) / 2;
const progressCircumference = 2 * Math.PI * progressRadius;
const compactHitSlop = { bottom: 6, left: 6, right: 6, top: 6 };

const getProgressAccessibilityValue = (
	progress: number | null,
	indeterminate: boolean,
	statusText: string,
) => {
	if (indeterminate || progress === null) {
		return { text: statusText };
	}

	const clampedProgress = Math.min(100, Math.max(0, progress));

	return {
		max: 100,
		min: 0,
		now: clampedProgress,
		text: `${clampedProgress}%`,
	};
};

function CapThumbnailPlaceholder() {
	return (
		<View style={styles.emptyThumbnail}>
			<View style={styles.placeholderSheen} />
			<View style={styles.placeholderMark}>
				<Svg width={34} height={34} viewBox="0 0 40 40">
					<Circle cx={20} cy={20} fill={colors.gray7} r={16} />
					<Circle cx={20} cy={20} fill={colors.gray5} r={13} />
					<Circle cx={20} cy={20} fill={colors.gray1} r={10} />
				</Svg>
			</View>
		</View>
	);
}

function UploadProgressIndicator({
	progress,
	indeterminate,
	statusText,
}: {
	progress: number | null;
	indeterminate: boolean;
	statusText: string;
}) {
	const accessibilityValue = getProgressAccessibilityValue(
		progress,
		indeterminate,
		statusText,
	);

	if (indeterminate || progress === null) {
		return (
			<View
				accessibilityLabel="Upload progress"
				accessibilityRole="progressbar"
				accessibilityValue={accessibilityValue}
				style={styles.progressIndicator}
			>
				<ActivityIndicator color={colors.white} size="small" />
			</View>
		);
	}

	const strokeDashoffset =
		progressCircumference -
		(Math.min(100, Math.max(0, progress)) / 100) * progressCircumference;

	return (
		<View
			accessibilityLabel="Upload progress"
			accessibilityRole="progressbar"
			accessibilityValue={accessibilityValue}
			style={styles.progressIndicator}
		>
			<View style={styles.progressRing}>
				<Svg width={progressSize} height={progressSize}>
					<Circle
						cx={progressSize / 2}
						cy={progressSize / 2}
						fill="none"
						r={progressRadius}
						stroke="rgba(255, 255, 255, 0.3)"
						strokeWidth={progressStrokeWidth}
					/>
					<Circle
						cx={progressSize / 2}
						cy={progressSize / 2}
						fill="none"
						r={progressRadius}
						stroke={colors.white}
						strokeDasharray={`${progressCircumference} ${progressCircumference}`}
						strokeDashoffset={strokeDashoffset}
						strokeLinecap="round"
						strokeWidth={progressStrokeWidth}
					/>
				</Svg>
			</View>
		</View>
	);
}

export function CapCard({
	cap,
	onPress,
	onCopyPress,
	onSharePress,
	onVisibilityPress,
	onAnalyticsPress,
	onMenuPress,
	visibilityBusy = false,
	visibilityDisabled = false,
	visibilityDisabledHint,
	visibilityValue,
	visibilityAccessibilityValue,
	now,
}: CapCardProps) {
	const viewModel = getCapCardViewModel(cap, now);
	const [copyPressed, setCopyPressed] = useState(false);
	const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hasCopyAction = Boolean(onCopyPress);
	const hasShareAction = Boolean(onSharePress);
	const hasVisibleMenuAction = Boolean(onMenuPress);
	const hasActions = hasCopyAction || hasShareAction || hasVisibleMenuAction;
	const visibilityActionDisabled = visibilityDisabled || visibilityBusy;
	const visibilityHint = visibilityActionDisabled
		? (visibilityDisabledHint ?? "Sharing update is in progress")
		: "Opens sharing settings";
	const visibilityText = visibilityValue ?? viewModel.visibility;
	const uploadIndeterminate =
		Boolean(cap.upload) &&
		cap.upload?.phase !== "uploading" &&
		(viewModel.uploadProgress ?? 0) === 0;

	useEffect(
		() => () => {
			if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
		},
		[],
	);

	const copyLink = () => {
		if (!onCopyPress) return;
		onCopyPress();
		setCopyPressed(true);
		if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
		copyResetTimer.current = setTimeout(() => {
			setCopyPressed(false);
			copyResetTimer.current = null;
		}, 1400);
	};

	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={viewModel.accessibilityLabel}
			onPress={onPress}
			onLongPress={onMenuPress}
			style={({ pressed }) => [styles.card, pressed && styles.pressed]}
		>
			<View style={styles.thumbnailWrap}>
				{hasActions ? (
					<View style={styles.actionStack}>
						{onCopyPress ? (
							<Pressable
								accessibilityRole="button"
								accessibilityLabel={`Copy link for ${cap.title}`}
								accessibilityHint="Copies this Cap link"
								hitSlop={compactHitSlop}
								onPress={(event) => {
									event.stopPropagation();
									copyLink();
								}}
								style={({ pressed }) => [
									styles.actionIconButton,
									pressed && styles.actionIconButtonPressed,
								]}
							>
								<SymbolView
									name={copyPressed ? "checkmark" : "link"}
									size={16}
									tintColor={colors.gray12}
									weight="semibold"
								/>
							</Pressable>
						) : null}
						{onSharePress ? (
							<Pressable
								accessibilityRole="button"
								accessibilityLabel={`Share ${cap.title}`}
								accessibilityHint="Opens the native share sheet"
								hitSlop={compactHitSlop}
								onPress={(event) => {
									event.stopPropagation();
									onSharePress();
								}}
								style={({ pressed }) => [
									styles.actionIconButton,
									pressed && styles.actionIconButtonPressed,
								]}
							>
								<SymbolView
									name="square.and.arrow.up"
									size={16}
									tintColor={colors.gray12}
									weight="semibold"
								/>
							</Pressable>
						) : null}
						{onMenuPress ? (
							<Pressable
								accessibilityRole="button"
								accessibilityLabel={`More actions for ${cap.title}`}
								accessibilityHint="Opens Cap actions"
								hitSlop={compactHitSlop}
								onPress={(event) => {
									event.stopPropagation();
									onMenuPress();
								}}
								style={({ pressed }) => [
									styles.actionIconButton,
									pressed && styles.actionIconButtonPressed,
								]}
							>
								<SymbolView
									name="ellipsis"
									size={17}
									tintColor={colors.gray12}
									weight="semibold"
								/>
							</Pressable>
						) : null}
					</View>
				) : null}
				{cap.thumbnailUrl ? (
					<Image source={{ uri: cap.thumbnailUrl }} style={styles.thumbnail} />
				) : (
					<CapThumbnailPlaceholder />
				)}
				{viewModel.uploadStatusText ? (
					<View pointerEvents="none" style={styles.uploadOverlay}>
						<View style={styles.uploadStatusRow}>
							<Text numberOfLines={1} style={styles.uploadStatusText}>
								{viewModel.uploadStatusText}
							</Text>
							{viewModel.uploadFailed ? null : (
								<UploadProgressIndicator
									indeterminate={uploadIndeterminate}
									progress={viewModel.uploadProgress}
									statusText={viewModel.uploadStatusText}
								/>
							)}
						</View>
					</View>
				) : null}
				{cap.protected ? (
					<View
						style={[
							styles.lockBadge,
							hasActions && styles.lockBadgeWithActions,
						]}
					>
						<SymbolView
							name="lock.fill"
							size={13}
							tintColor={colors.white}
							weight="semibold"
						/>
					</View>
				) : null}
				{viewModel.duration ? (
					<View style={styles.durationPill}>
						<Text style={styles.durationText}>{viewModel.duration}</Text>
					</View>
				) : null}
			</View>
			<View style={styles.body}>
				<View>
					<Text numberOfLines={1} style={styles.title}>
						{cap.title}
					</Text>
					{onVisibilityPress ? (
						<Pressable
							accessibilityRole="button"
							accessibilityLabel={`Change sharing for ${cap.title}`}
							accessibilityHint={visibilityHint}
							accessibilityState={{
								busy: visibilityBusy,
								disabled: visibilityActionDisabled,
							}}
							accessibilityValue={
								visibilityAccessibilityValue
									? { text: visibilityAccessibilityValue }
									: undefined
							}
							disabled={visibilityActionDisabled}
							hitSlop={compactHitSlop}
							onPress={(event) => {
								event.stopPropagation();
								onVisibilityPress();
							}}
							style={({ pressed }) => [
								styles.shareStateButton,
								pressed &&
									!visibilityActionDisabled &&
									styles.shareStateButtonPressed,
								visibilityActionDisabled && styles.shareStateButtonDisabled,
							]}
						>
							<Text
								numberOfLines={1}
								style={[
									styles.shareState,
									visibilityActionDisabled && styles.shareStateDisabled,
								]}
							>
								{visibilityText}
							</Text>
							<SymbolView
								name="chevron.down"
								size={10}
								tintColor={
									visibilityActionDisabled ? colors.gray8 : colors.gray10
								}
								weight="semibold"
							/>
						</Pressable>
					) : (
						<Text numberOfLines={1} style={styles.shareState}>
							{viewModel.visibility}
						</Text>
					)}
					<Text numberOfLines={1} style={styles.meta}>
						{viewModel.date}
					</Text>
				</View>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={`View analytics for ${cap.title}`}
					accessibilityHint={
						onAnalyticsPress ? "Opens analytics in a browser sheet" : undefined
					}
					accessibilityState={{ disabled: !onAnalyticsPress }}
					disabled={!onAnalyticsPress}
					onPress={(event) => {
						event.stopPropagation();
						onAnalyticsPress?.();
					}}
					style={({ pressed }) => [
						styles.metricsRow,
						onAnalyticsPress && styles.metricsRowAction,
						pressed && onAnalyticsPress && styles.metricsRowPressed,
					]}
				>
					<View style={styles.metric}>
						<SymbolView
							name="eye"
							size={15}
							tintColor={colors.gray8}
							weight="medium"
						/>
						<Text style={styles.metricText}>{cap.viewCount}</Text>
					</View>
					<View style={styles.metric}>
						<SymbolView
							name="text.bubble"
							size={15}
							tintColor={colors.gray8}
							weight="medium"
						/>
						<Text style={styles.metricText}>{cap.commentCount}</Text>
					</View>
					<View style={styles.metric}>
						<SymbolView
							name="face.smiling"
							size={15}
							tintColor={colors.gray8}
							weight="medium"
						/>
						<Text style={styles.metricText}>{cap.reactionCount}</Text>
					</View>
					{onAnalyticsPress ? (
						<Text style={styles.analyticsLink}>View analytics</Text>
					) : null}
				</Pressable>
			</View>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	card: {
		backgroundColor: colors.gray1,
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		overflow: "hidden",
		marginBottom: 16,
		...squircle,
	},
	pressed: {
		backgroundColor: colors.gray2,
		borderColor: colors.blue10,
	},
	thumbnailWrap: {
		width: "100%",
		aspectRatio: 16 / 9,
		backgroundColor: colors.black,
		position: "relative",
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: colors.gray3,
	},
	thumbnail: {
		width: "100%",
		height: "100%",
	},
	emptyThumbnail: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.gray3,
		overflow: "hidden",
	},
	placeholderSheen: {
		position: "absolute",
		top: -36,
		left: -28,
		width: "78%",
		height: "140%",
		backgroundColor: "rgba(255, 255, 255, 0.34)",
		transform: [{ rotate: "18deg" }],
	},
	placeholderMark: {
		width: 48,
		height: 48,
		borderRadius: radius.full,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "rgba(255, 255, 255, 0.72)",
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: "rgba(255, 255, 255, 0.95)",
		...squircle,
	},
	durationPill: {
		position: "absolute",
		left: 12,
		bottom: 12,
		minWidth: 46,
		height: 23,
		borderRadius: radius.full,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "rgba(0, 0, 0, 0.5)",
		paddingHorizontal: 8,
		...squircle,
	},
	durationText: {
		fontFamily: fonts.medium,
		fontSize: 11,
		color: colors.white,
	},
	lockBadge: {
		position: "absolute",
		right: 10,
		top: 10,
		zIndex: 2,
		width: 28,
		height: 28,
		borderRadius: radius.full,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "rgba(0, 0, 0, 0.7)",
	},
	lockBadgeWithActions: {
		right: 46,
	},
	actionStack: {
		position: "absolute",
		right: 10,
		top: 10,
		zIndex: 2,
		gap: 8,
	},
	actionIconButton: {
		width: 32,
		height: 32,
		borderRadius: radius.full,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.gray3,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray5,
		shadowColor: colors.black,
		shadowOffset: { width: 0, height: 2 },
		shadowOpacity: 0.1,
		shadowRadius: 8,
		elevation: 2,
		...squircle,
	},
	actionIconButtonPressed: {
		backgroundColor: colors.gray5,
		borderColor: colors.gray7,
	},
	uploadOverlay: {
		...StyleSheet.absoluteFillObject,
		justifyContent: "flex-end",
		backgroundColor: "rgba(0, 0, 0, 0.58)",
		paddingHorizontal: 12,
		paddingBottom: 12,
		zIndex: 1,
	},
	uploadStatusRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingRight: 96,
	},
	uploadStatusText: {
		fontFamily: fonts.medium,
		fontSize: 14,
		lineHeight: 19,
		color: colors.white,
	},
	progressIndicator: {
		width: progressSize,
		height: progressSize,
		alignItems: "center",
		justifyContent: "center",
	},
	progressRing: {
		transform: [{ rotate: "-90deg" }],
	},
	body: {
		paddingHorizontal: 16,
		paddingBottom: 16,
		gap: 12,
	},
	title: {
		fontFamily: fonts.medium,
		fontSize: 16,
		lineHeight: 21,
		color: colors.gray12,
		marginTop: 13,
		marginBottom: 4,
	},
	shareState: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 19,
		color: colors.gray10,
	},
	shareStateButton: {
		alignSelf: "flex-start",
		minHeight: 22,
		maxWidth: "100%",
		flexDirection: "row",
		alignItems: "center",
		gap: 5,
		marginBottom: 2,
		borderRadius: radius.xs,
		paddingHorizontal: 3,
		marginLeft: -3,
		...squircle,
	},
	shareStateButtonPressed: {
		backgroundColor: colors.gray3,
	},
	shareStateButtonDisabled: {
		backgroundColor: colors.gray2,
	},
	shareStateDisabled: {
		color: colors.gray8,
	},
	meta: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.gray10,
	},
	metricsRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 16,
		minHeight: 24,
	},
	metricsRowAction: {
		width: "100%",
		maxWidth: "100%",
		borderRadius: radius.xs,
		paddingHorizontal: 3,
		marginLeft: -3,
		...squircle,
	},
	metricsRowPressed: {
		backgroundColor: colors.gray3,
	},
	metric: {
		flexDirection: "row",
		alignItems: "center",
		gap: 7,
	},
	metricText: {
		fontFamily: fonts.regular,
		fontSize: 14,
		color: colors.gray12,
	},
	analyticsLink: {
		marginLeft: "auto",
		fontFamily: fonts.regular,
		fontSize: 12,
		lineHeight: 17,
		color: colors.blue11,
	},
});
