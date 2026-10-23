import { Stack, useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { MobileAnalyticsData, MobileAnalyticsRange } from "@/api/mobile";
import { MobileApiError } from "@/api/mobile";
import { useAuth } from "@/auth/AuthContext";
import { SignInPanel } from "@/auth/SignInPanel";
import { ActionButton } from "@/components/ActionButton";
import { CapLoadingIndicator } from "@/components/CapLoadingIndicator";
import { GlassSurface } from "@/components/GlassSurface";
import { Screen } from "@/components/Screen";
import { colors, fonts, radius, squircle } from "@/theme";

type AnalyticsPoint = MobileAnalyticsData["chart"][number];

const ranges: Array<{ label: string; value: MobileAnalyticsRange }> = [
	{ label: "24H", value: "24h" },
	{ label: "7D", value: "7d" },
	{ label: "30D", value: "30d" },
	{ label: "All", value: "lifetime" },
];

const numberFormatter = new Intl.NumberFormat();

export const downsampleAnalyticsChart = (
	points: readonly AnalyticsPoint[],
	limit = 48,
) => {
	if (points.length <= limit) return [...points];
	const groupSize = Math.ceil(points.length / limit);
	const sampled: AnalyticsPoint[] = [];
	for (let index = 0; index < points.length; index += groupSize) {
		const group = points.slice(index, index + groupSize);
		const last = group.at(-1);
		if (!last) continue;
		sampled.push({
			bucket: last.bucket,
			caps: group.reduce((total, point) => total + point.caps, 0),
			views: group.reduce((total, point) => total + point.views, 0),
			comments: group.reduce((total, point) => total + point.comments, 0),
			reactions: group.reduce((total, point) => total + point.reactions, 0),
		});
	}
	return sampled;
};

const chartPath = (points: readonly AnalyticsPoint[]) => {
	if (points.length === 0) return "";
	const width = 320;
	const height = 112;
	const max = Math.max(...points.map((point) => point.views), 1);
	return points
		.map((point, index) => {
			const x =
				points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
			const y = height - (point.views / max) * (height - 8) - 4;
			return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
		})
		.join(" ");
};

const errorMessage = (error: unknown) => {
	if (error instanceof MobileApiError && error.status === 401) {
		return "Your session expired. Sign in again.";
	}
	return "Analytics could not load. Check your connection and try again.";
};

function MetricCard({
	label,
	value,
	symbol,
}: {
	label: string;
	value: number;
	symbol: "eye" | "text.bubble" | "face.smiling" | "video";
}) {
	return (
		<GlassSurface
			fallbackStyle={styles.cardFallback}
			style={styles.metricCard}
			tintColor={colors.gray1}
		>
			<View style={styles.metricLabelRow}>
				<SymbolView name={symbol} size={15} tintColor={colors.gray9} />
				<Text style={styles.metricLabel}>{label}</Text>
			</View>
			<Text style={styles.metricValue}>{numberFormatter.format(value)}</Text>
		</GlassSurface>
	);
}

function Breakdown({
	label,
	rows,
}: {
	label: string;
	rows: MobileAnalyticsData["breakdowns"]["countries"];
}) {
	if (rows.length === 0) return null;
	return (
		<View style={styles.breakdownSection}>
			<Text style={styles.sectionTitle}>{label}</Text>
			<GlassSurface
				fallbackStyle={styles.cardFallback}
				style={styles.breakdownCard}
				tintColor={colors.gray1}
			>
				{rows.slice(0, 5).map((row, index) => (
					<View
						key={`${row.name}-${index}`}
						style={[styles.breakdownRow, index > 0 && styles.divider]}
					>
						<View style={styles.breakdownText}>
							<Text numberOfLines={1} style={styles.breakdownName}>
								{row.name || "Unknown"}
							</Text>
							{row.subtitle ? (
								<Text numberOfLines={1} style={styles.breakdownSubtitle}>
									{row.subtitle}
								</Text>
							) : null}
						</View>
						<Text style={styles.breakdownValue}>
							{numberFormatter.format(row.views)} · {Math.round(row.percentage)}
							%
						</Text>
					</View>
				))}
			</GlassSurface>
		</View>
	);
}

export default function AnalyticsScreen() {
	const auth = useAuth();
	const params = useLocalSearchParams<{ capId?: string | string[] }>();
	const capId = Array.isArray(params.capId) ? params.capId[0] : params.capId;
	const [range, setRange] = useState<MobileAnalyticsRange>("7d");
	const [data, setData] = useState<MobileAnalyticsData | null>(null);
	const [available, setAvailable] = useState(true);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const requestRef = useRef(0);

	const load = useCallback(() => {
		if (auth.status !== "signedIn" || !capId) {
			setLoading(false);
			return;
		}
		const requestId = ++requestRef.current;
		setLoading(true);
		setError(null);
		auth.client
			.getCapAnalytics(capId, range)
			.then((response) => {
				if (requestRef.current !== requestId) return;
				setAvailable(response.available);
				setData(response.data);
			})
			.catch((cause: unknown) => {
				if (requestRef.current !== requestId) return;
				setError(errorMessage(cause));
			})
			.finally(() => {
				if (requestRef.current === requestId) setLoading(false);
			});
	}, [auth.client, auth.status, capId, range]);

	useEffect(() => {
		load();
		return () => {
			requestRef.current += 1;
		};
	}, [load]);

	const points = useMemo(
		() => downsampleAnalyticsChart(data?.chart ?? []),
		[data?.chart],
	);
	const path = useMemo(() => chartPath(points), [points]);

	if (auth.status === "signedOut") {
		return (
			<Screen scroll safeEdges={["left", "right", "bottom"]}>
				<SignInPanel title="Sign in to view analytics" />
			</Screen>
		);
	}

	return (
		<>
			<Stack.Screen
				options={{
					headerShown: true,
					title: "Analytics",
					headerBackTitle: "Back",
					headerShadowVisible: false,
					headerStyle: { backgroundColor: colors.appBackground },
				}}
			/>
			<Screen scroll safeEdges={["left", "right", "bottom"]}>
				<View style={styles.heading}>
					<Text numberOfLines={2} style={styles.title}>
						{data?.capName ?? "Cap analytics"}
					</Text>
					<Text style={styles.subtitle}>
						Views and engagement for this Cap.
					</Text>
				</View>
				<View accessibilityRole="tablist" style={styles.rangeSelector}>
					{ranges.map((item) => {
						const selected = item.value === range;
						return (
							<Pressable
								accessibilityRole="tab"
								accessibilityState={{ selected }}
								disabled={loading}
								key={item.value}
								onPress={() => setRange(item.value)}
								style={({ pressed }) => [
									styles.rangeButton,
									selected && styles.rangeButtonSelected,
									pressed && styles.rangeButtonPressed,
								]}
							>
								<Text
									style={[
										styles.rangeLabel,
										selected && styles.rangeLabelSelected,
									]}
								>
									{item.label}
								</Text>
							</Pressable>
						);
					})}
				</View>
				{loading ? (
					<View style={styles.state}>
						<CapLoadingIndicator />
						<Text style={styles.stateText}>Loading analytics…</Text>
					</View>
				) : error || !capId ? (
					<View style={styles.state}>
						<SymbolView
							name="exclamationmark.triangle"
							size={30}
							tintColor={colors.red9}
						/>
						<Text style={styles.stateTitle}>Analytics unavailable</Text>
						<Text style={styles.stateText}>
							{error ?? "This Cap could not be identified."}
						</Text>
						{capId ? (
							<ActionButton
								label="Try again"
								onPress={load}
								variant="secondary"
							/>
						) : null}
					</View>
				) : !available ? (
					<View style={styles.state}>
						<SymbolView name="chart.bar" size={32} tintColor={colors.blue9} />
						<Text style={styles.stateTitle}>Analytics is a Pro feature</Text>
						<Text style={styles.stateText}>
							Your current plan does not include analytics.
						</Text>
					</View>
				) : data ? (
					<>
						<View style={styles.metrics}>
							<MetricCard
								label="Views"
								symbol="eye"
								value={data.counts.views}
							/>
							<MetricCard
								label="Comments"
								symbol="text.bubble"
								value={data.counts.comments}
							/>
							<MetricCard
								label="Reactions"
								symbol="face.smiling"
								value={data.counts.reactions}
							/>
							<MetricCard
								label="Caps"
								symbol="video"
								value={data.counts.caps}
							/>
						</View>
						<View style={styles.chartSection}>
							<Text style={styles.sectionTitle}>Views over time</Text>
							<GlassSurface
								fallbackStyle={styles.cardFallback}
								style={styles.chartCard}
								tintColor={colors.gray1}
							>
								{data.counts.views === 0 ? (
									<View style={styles.emptyChart}>
										<Text style={styles.stateText}>
											No views in this range yet.
										</Text>
									</View>
								) : (
									<Svg
										accessibilityLabel="Views trend chart"
										height={120}
										viewBox="0 0 320 120"
										width="100%"
									>
										<Path
											d={path}
											fill="none"
											stroke={colors.blue9}
											strokeLinecap="round"
											strokeLinejoin="round"
											strokeWidth={3}
										/>
									</Svg>
								)}
							</GlassSurface>
						</View>
						<Breakdown label="Countries" rows={data.breakdowns.countries} />
						<Breakdown label="Cities" rows={data.breakdowns.cities} />
						<Breakdown label="Devices" rows={data.breakdowns.devices} />
						<Breakdown label="Browsers" rows={data.breakdowns.browsers} />
						<Breakdown
							label="Operating systems"
							rows={data.breakdowns.operatingSystems}
						/>
					</>
				) : null}
			</Screen>
		</>
	);
}

const styles = StyleSheet.create({
	heading: {
		paddingTop: 10,
		paddingBottom: 20,
		gap: 4,
	},
	title: {
		fontFamily: fonts.medium,
		fontSize: 24,
		lineHeight: 30,
		color: colors.gray12,
	},
	subtitle: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.gray10,
	},
	rangeSelector: {
		flexDirection: "row",
		padding: 3,
		borderRadius: radius.md,
		backgroundColor: colors.gray3,
		marginBottom: 20,
		...squircle,
	},
	rangeButton: {
		flex: 1,
		alignItems: "center",
		paddingVertical: 8,
		borderRadius: radius.sm,
		...squircle,
	},
	rangeButtonSelected: {
		backgroundColor: colors.white,
	},
	rangeButtonPressed: {
		opacity: 0.7,
	},
	rangeLabel: {
		fontFamily: fonts.medium,
		fontSize: 13,
		color: colors.gray10,
	},
	rangeLabelSelected: {
		color: colors.gray12,
	},
	state: {
		minHeight: 300,
		alignItems: "center",
		justifyContent: "center",
		gap: 12,
		paddingHorizontal: 24,
	},
	stateTitle: {
		fontFamily: fonts.medium,
		fontSize: 18,
		color: colors.gray12,
		textAlign: "center",
	},
	stateText: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.gray10,
		textAlign: "center",
	},
	metrics: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 10,
	},
	metricCard: {
		width: "48%",
		flexGrow: 1,
		padding: 14,
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray4,
		gap: 8,
		...squircle,
	},
	cardFallback: {
		backgroundColor: colors.gray1,
	},
	metricLabelRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
	},
	metricLabel: {
		fontFamily: fonts.regular,
		fontSize: 13,
		color: colors.gray10,
	},
	metricValue: {
		fontFamily: fonts.medium,
		fontSize: 24,
		color: colors.gray12,
	},
	chartSection: {
		marginTop: 24,
		gap: 8,
	},
	sectionTitle: {
		fontFamily: fonts.medium,
		fontSize: 14,
		color: colors.gray11,
		paddingHorizontal: 4,
	},
	chartCard: {
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray4,
		padding: 14,
		...squircle,
	},
	emptyChart: {
		height: 120,
		alignItems: "center",
		justifyContent: "center",
	},
	breakdownSection: {
		marginTop: 24,
		gap: 8,
	},
	breakdownCard: {
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray4,
		overflow: "hidden",
		...squircle,
	},
	breakdownRow: {
		minHeight: 56,
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingHorizontal: 14,
	},
	divider: {
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.gray4,
	},
	breakdownText: {
		flex: 1,
		minWidth: 0,
	},
	breakdownName: {
		fontFamily: fonts.medium,
		fontSize: 15,
		color: colors.gray12,
	},
	breakdownSubtitle: {
		fontFamily: fonts.regular,
		fontSize: 12,
		color: colors.gray9,
		marginTop: 2,
	},
	breakdownValue: {
		fontFamily: fonts.regular,
		fontSize: 13,
		color: colors.gray10,
	},
});
