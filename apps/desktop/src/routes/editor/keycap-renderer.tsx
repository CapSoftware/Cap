import { createMemo, createUniqueId, For, Show } from "solid-js";
import type { KeycapStyle, KeycapTheme } from "~/store/keyboard";

export interface KeycapColorPalette {
	surfaceTop: string;
	surfaceMid: string;
	surfaceBottom: string;
	surfaceStroke: string;
	dishTop: string;
	dishBottom: string;
	textColor: string;
}

export const THEME_PALETTES: Record<
	KeycapTheme,
	{ alpha: KeycapColorPalette; mod: KeycapColorPalette }
> = {
	white: {
		alpha: {
			surfaceTop: "#F8F8F8",
			surfaceMid: "#EFEFEF",
			surfaceBottom: "#DCDCDC",
			surfaceStroke: "#C7C7C7",
			dishTop: "#FFFFFF",
			dishBottom: "#F0F0F0",
			textColor: "#2B2A27",
		},
		mod: {
			surfaceTop: "#F1F1F1",
			surfaceMid: "#E5E5E5",
			surfaceBottom: "#D2D2D2",
			surfaceStroke: "#BFBFBF",
			dishTop: "#FAFAFA",
			dishBottom: "#E8E8E8",
			textColor: "#1A1A1A",
		},
	},
	black: {
		alpha: {
			surfaceTop: "#2C2C30",
			surfaceMid: "#1E1E22",
			surfaceBottom: "#141416",
			surfaceStroke: "#42424A",
			dishTop: "#242428",
			dishBottom: "#1A1A1E",
			textColor: "#F5F5F7",
		},
		mod: {
			surfaceTop: "#222226",
			surfaceMid: "#18181A",
			surfaceBottom: "#101012",
			surfaceStroke: "#383840",
			dishTop: "#1E1E22",
			dishBottom: "#141416",
			textColor: "#E2E2E6",
		},
	},
	ocean: {
		alpha: {
			surfaceTop: "#3B82F6",
			surfaceMid: "#2563EB",
			surfaceBottom: "#1D4ED8",
			surfaceStroke: "#60A5FA",
			dishTop: "#60A5FA",
			dishBottom: "#2563EB",
			textColor: "#FFFFFF",
		},
		mod: {
			surfaceTop: "#2563EB",
			surfaceMid: "#1D4ED8",
			surfaceBottom: "#1E40AF",
			surfaceStroke: "#3B82F6",
			dishTop: "#3B82F6",
			dishBottom: "#1D4ED8",
			textColor: "#FFFFFF",
		},
	},
	emerald: {
		alpha: {
			surfaceTop: "#10B981",
			surfaceMid: "#059669",
			surfaceBottom: "#047857",
			surfaceStroke: "#34D399",
			dishTop: "#34D399",
			dishBottom: "#059669",
			textColor: "#FFFFFF",
		},
		mod: {
			surfaceTop: "#059669",
			surfaceMid: "#047857",
			surfaceBottom: "#065F46",
			surfaceStroke: "#10B981",
			dishTop: "#10B981",
			dishBottom: "#047857",
			textColor: "#FFFFFF",
		},
	},
	amber: {
		alpha: {
			surfaceTop: "#F59E0B",
			surfaceMid: "#D97706",
			surfaceBottom: "#B45309",
			surfaceStroke: "#FBBF24",
			dishTop: "#FBBF24",
			dishBottom: "#D97706",
			textColor: "#FFFFFF",
		},
		mod: {
			surfaceTop: "#D97706",
			surfaceMid: "#B45309",
			surfaceBottom: "#92400E",
			surfaceStroke: "#F59E0B",
			dishTop: "#F59E0B",
			dishBottom: "#B45309",
			textColor: "#FFFFFF",
		},
	},
	rose: {
		alpha: {
			surfaceTop: "#F43F5E",
			surfaceMid: "#E11D48",
			surfaceBottom: "#BE123C",
			surfaceStroke: "#FB7185",
			dishTop: "#FB7185",
			dishBottom: "#E11D48",
			textColor: "#FFFFFF",
		},
		mod: {
			surfaceTop: "#E11D48",
			surfaceMid: "#BE123C",
			surfaceBottom: "#9F1239",
			surfaceStroke: "#F43F5E",
			dishTop: "#F43F5E",
			dishBottom: "#BE123C",
			textColor: "#FFFFFF",
		},
	},
	purple: {
		alpha: {
			surfaceTop: "#8B5CF6",
			surfaceMid: "#7C3AED",
			surfaceBottom: "#6D28D9",
			surfaceStroke: "#A78BFA",
			dishTop: "#A78BFA",
			dishBottom: "#7C3AED",
			textColor: "#FFFFFF",
		},
		mod: {
			surfaceTop: "#7C3AED",
			surfaceMid: "#6D28D9",
			surfaceBottom: "#5B21B6",
			surfaceStroke: "#8B5CF6",
			dishTop: "#8B5CF6",
			dishBottom: "#6D28D9",
			textColor: "#FFFFFF",
		},
	},
};

export interface ChassisThemeTokens {
	background: string;
	border: string;
	boxShadow: string;
	backdropFilter?: string;
}

export const THEME_CHASSIS: Record<KeycapTheme, ChassisThemeTokens> = {
	white: {
		background: "rgba(238, 238, 242, 0.94)",
		border: "1.5px solid rgba(0, 0, 0, 0.12)",
		boxShadow:
			"0 12px 28px rgba(0, 0, 0, 0.16), 0 4px 10px rgba(0, 0, 0, 0.08)",
		backdropFilter: "blur(20px) saturate(180%)",
	},
	black: {
		background: "rgba(20, 20, 24, 0.94)",
		border: "1.5px solid rgba(255, 255, 255, 0.14)",
		boxShadow:
			"0 14px 28px rgba(0, 0, 0, 0.55), 0 4px 10px rgba(0, 0, 0, 0.35)",
		backdropFilter: "blur(20px) saturate(180%)",
	},
	ocean: {
		background: "rgba(20, 32, 58, 0.92)",
		border: "1.5px solid rgba(96, 165, 250, 0.3)",
		boxShadow:
			"0 14px 28px rgba(0, 0, 0, 0.45), 0 4px 10px rgba(37, 99, 235, 0.25)",
		backdropFilter: "blur(20px) saturate(180%)",
	},
	emerald: {
		background: "rgba(10, 36, 26, 0.92)",
		border: "1.5px solid rgba(52, 211, 153, 0.3)",
		boxShadow:
			"0 14px 28px rgba(0, 0, 0, 0.45), 0 4px 10px rgba(5, 150, 105, 0.25)",
		backdropFilter: "blur(20px) saturate(180%)",
	},
	amber: {
		background: "rgba(38, 24, 8, 0.92)",
		border: "1.5px solid rgba(251, 191, 36, 0.3)",
		boxShadow:
			"0 14px 28px rgba(0, 0, 0, 0.45), 0 4px 10px rgba(217, 119, 6, 0.25)",
		backdropFilter: "blur(20px) saturate(180%)",
	},
	rose: {
		background: "rgba(38, 14, 22, 0.92)",
		border: "1.5px solid rgba(251, 113, 133, 0.3)",
		boxShadow:
			"0 14px 28px rgba(0, 0, 0, 0.45), 0 4px 10px rgba(225, 29, 72, 0.25)",
		backdropFilter: "blur(20px) saturate(180%)",
	},
	purple: {
		background: "rgba(28, 14, 48, 0.92)",
		border: "1.5px solid rgba(167, 139, 250, 0.3)",
		boxShadow:
			"0 14px 28px rgba(0, 0, 0, 0.45), 0 4px 10px rgba(124, 58, 237, 0.25)",
		backdropFilter: "blur(20px) saturate(180%)",
	},
};

export interface SingleKeycapProps {
	keyText?: string;
	label?: string;
	isModifier?: boolean;
	style?: KeycapStyle;
	theme?: KeycapTheme;
	scale?: number;
	is3D?: boolean;
	showChassis?: boolean;
	customTextColor?: string;
	customBgColor?: string;
}

export function parseShortcutKeys(text: string): string[] {
	if (!text) return [];
	if (text.includes("+")) {
		return text
			.split("+")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	if (text.includes(" ")) {
		return text
			.split(" ")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	const modifierSymbols = ["⌘", "⌃", "⌥", "⇧"];
	const result: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		const matchedModifier = modifierSymbols.find((mod) =>
			remaining.startsWith(mod),
		);
		if (matchedModifier) {
			result.push(matchedModifier);
			remaining = remaining.slice(matchedModifier.length);
		} else {
			result.push(remaining);
			break;
		}
	}
	return result.filter(Boolean);
}

export const KeycapUnit = (props: SingleKeycapProps) => SingleKeycap(props);

export function SingleKeycap(props: SingleKeycapProps) {
	const text = () => props.keyText ?? props.label ?? "A";
	const style = () => props.style || "pbt";
	const theme = () => props.theme || "white";
	const scale = () => props.scale || 1.0;
	const isMod = () => props.isModifier || false;
	const is3D = () => props.is3D ?? true;

	const palette = createMemo(() => {
		const themeData = THEME_PALETTES[theme()] || THEME_PALETTES.white;
		const base = isMod() ? themeData.mod : themeData.alpha;
		const customText = props.customTextColor;
		const customBg = props.customBgColor;
		const hasCustomText =
			customText && customText !== "#FFFFFF" && customText !== "";
		const hasCustomBg = customBg && customBg !== "#000000" && customBg !== "";

		if (!hasCustomText && !hasCustomBg) {
			return base;
		}

		return {
			...base,
			...(hasCustomText ? { textColor: customText } : {}),
			...(hasCustomBg
				? {
						surfaceTop: customBg,
						surfaceMid: customBg,
						surfaceBottom: customBg,
						dishTop: customBg,
						dishBottom: customBg,
					}
				: {}),
		};
	});

	const instanceId = createUniqueId();
	const uid = () =>
		`cap_${instanceId}_${style()}_${text().replace(/[^a-zA-Z0-9]/g, "")}_${isMod() ? "m" : "a"}`;

	const displayLabel = () => {
		const k = text();
		const lower = k.toLowerCase();
		if (
			lower === "command" ||
			lower === "cmd" ||
			lower === "meta" ||
			lower === "lmeta" ||
			lower === "rmeta"
		)
			return "⌘";
		if (
			lower === "control" ||
			lower === "ctrl" ||
			lower === "lcontrol" ||
			lower === "rcontrol"
		)
			return "Ctrl";
		if (
			lower === "alt" ||
			lower === "option" ||
			lower === "lalt" ||
			lower === "ralt"
		)
			return "Alt";
		if (lower === "shift" || lower === "lshift" || lower === "rshift")
			return "⇧";
		if (lower === "return" || lower === "enter") return "⏎";
		if (lower === "backspace" || lower === "delete") return "⌫";
		if (lower === "escape" || lower === "esc") return "Esc";
		if (lower === "space") return "␣";
		return k.toUpperCase();
	};

	const renderPBT = () => {
		const w = displayLabel().length > 2 ? 88 : 68;
		const h = 68;
		return (
			<svg
				width={w * scale()}
				height={h * scale()}
				viewBox={`0 0 ${w} ${h}`}
				class="select-none overflow-visible"
			>
				<defs>
					<linearGradient
						id={`${uid()}_skirt`}
						x1="0%"
						y1="0%"
						x2="0%"
						y2="100%"
					>
						<stop offset="0%" stop-color={palette().surfaceTop} />
						<stop offset="45%" stop-color={palette().surfaceMid} />
						<stop offset="100%" stop-color={palette().surfaceBottom} />
					</linearGradient>
					<linearGradient
						id={`${uid()}_dish`}
						x1="0%"
						y1="0%"
						x2="0%"
						y2="100%"
					>
						<stop offset="0%" stop-color={palette().dishTop} />
						<stop offset="100%" stop-color={palette().dishBottom} />
					</linearGradient>
				</defs>
				<rect
					x="2"
					y="2"
					width={w - 4}
					height={h - 4}
					rx="12"
					ry="12"
					fill={is3D() ? `url(#${uid()}_skirt)` : palette().surfaceMid}
					stroke={palette().surfaceStroke}
					stroke-width="1.2"
				/>
				<rect
					x="7"
					y="5"
					width={w - 14}
					height={h - 14}
					rx="8"
					ry="8"
					fill={is3D() ? `url(#${uid()}_dish)` : palette().surfaceTop}
				/>
				<text
					x={w / 2}
					y={h / 2 + 1}
					text-anchor="middle"
					dominant-baseline="central"
					fill={palette().textColor}
					font-family="system-ui, -apple-system, sans-serif"
					font-size={String(displayLabel().length > 2 ? 14 : 19)}
					font-weight="600"
				>
					{displayLabel()}
				</text>
			</svg>
		);
	};

	const renderApple = () => {
		const w = displayLabel().length > 2 ? 82 : 62;
		const h = 62;
		return (
			<svg
				width={w * scale()}
				height={h * scale()}
				viewBox={`0 0 ${w} ${h}`}
				class="select-none overflow-visible"
			>
				<defs>
					<linearGradient
						id={`${uid()}_apple`}
						x1="0%"
						y1="0%"
						x2="0%"
						y2="100%"
					>
						<stop offset="0%" stop-color={palette().dishTop} />
						<stop offset="100%" stop-color={palette().dishBottom} />
					</linearGradient>
				</defs>
				<Show when={is3D()}>
					<rect
						x="2"
						y="6"
						width={w - 4}
						height={h - 8}
						rx="14"
						ry="14"
						fill={palette().surfaceBottom}
					/>
				</Show>
				<rect
					x="2"
					y="2"
					width={w - 4}
					height={h - 8}
					rx="14"
					ry="14"
					fill={is3D() ? `url(#${uid()}_apple)` : palette().surfaceMid}
					stroke={palette().surfaceStroke}
					stroke-width="1"
				/>
				<text
					x={w / 2}
					y={(h - 6) / 2 + 2}
					text-anchor="middle"
					dominant-baseline="central"
					fill={palette().textColor}
					font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif"
					font-size={String(displayLabel().length > 2 ? 13 : 18)}
					font-weight="500"
				>
					{displayLabel()}
				</text>
			</svg>
		);
	};

	const renderMinimal = () => {
		const w = displayLabel().length > 2 ? 76 : 56;
		const h = 56;
		return (
			<svg
				width={w * scale()}
				height={h * scale()}
				viewBox={`0 0 ${w} ${h}`}
				class="select-none overflow-visible"
			>
				<rect
					x="1.5"
					y="1.5"
					width={w - 3}
					height={h - 3}
					rx="14"
					ry="14"
					fill={palette().dishBottom}
					stroke={palette().surfaceStroke}
					stroke-width="1.2"
				/>
				<text
					x={w / 2}
					y={h / 2}
					text-anchor="middle"
					dominant-baseline="central"
					fill={palette().textColor}
					font-family="system-ui, sans-serif"
					font-size={String(displayLabel().length > 2 ? 13 : 18)}
					font-weight="600"
				>
					{displayLabel()}
				</text>
			</svg>
		);
	};

	const renderRetro = () => {
		const w = displayLabel().length > 2 ? 86 : 66;
		const h = 66;
		return (
			<svg
				width={w * scale()}
				height={h * scale()}
				viewBox={`0 0 ${w} ${h}`}
				class="select-none overflow-visible"
			>
				<Show when={is3D()}>
					<rect
						x="2"
						y="4"
						width={w - 4}
						height={h - 6}
						rx="16"
						ry="16"
						fill={palette().surfaceBottom}
					/>
				</Show>
				<rect
					x="3"
					y="2"
					width={w - 6}
					height={h - 8}
					rx="14"
					ry="14"
					fill={palette().surfaceMid}
					stroke={palette().surfaceStroke}
					stroke-width="1.2"
				/>
				<rect
					x="8"
					y="6"
					width={w - 16}
					height={h - 16}
					rx="10"
					ry="10"
					fill={palette().dishTop}
				/>
				<text
					x={w / 2}
					y={h / 2 - 1}
					text-anchor="middle"
					dominant-baseline="central"
					fill={palette().textColor}
					font-family="Courier New, monospace"
					font-size={String(displayLabel().length > 2 ? 14 : 20)}
					font-weight="bold"
				>
					{displayLabel()}
				</text>
			</svg>
		);
	};

	const renderClassicBox = () => {
		return (
			<span class="inline-flex items-center justify-center px-2.5 py-1 text-sm font-semibold rounded bg-black/80 text-white border border-white/20">
				{displayLabel()}
			</span>
		);
	};

	return (
		<Show when={style() !== "classic_box"} fallback={renderClassicBox()}>
			<div
				class="inline-flex items-center justify-center transition-transform hover:scale-105 active:scale-95"
				style={{
					filter:
						props.showChassis === false
							? "drop-shadow(0 3px 6px rgba(0, 0, 0, 0.22))"
							: undefined,
				}}
			>
				<Show when={style() === "pbt"}>{renderPBT()}</Show>
				<Show when={style() === "apple"}>{renderApple()}</Show>
				<Show when={style() === "minimal"}>{renderMinimal()}</Show>
				<Show when={style() === "retro" || style() === "m0116"}>
					{renderRetro()}
				</Show>
			</div>
		</Show>
	);
}

export function KeycapPreviewCluster(props: {
	keys?: string[];
	style?: KeycapStyle;
	theme?: KeycapTheme;
	showChassis?: boolean;
	use3D?: boolean;
	scale?: number;
	customTextColor?: string;
	customBgColor?: string;
}) {
	const keys = () => props.keys || ["⌘", "K"];
	const showChassis = () => props.showChassis ?? true;
	const use3D = () => props.use3D ?? true;
	const style = () => props.style || "pbt";
	const theme = () => props.theme || "white";
	const scale = () => props.scale || 1.0;
	const chassisTheme = () => THEME_CHASSIS[theme()] || THEME_CHASSIS.white;

	return (
		<div
			class="relative inline-flex items-center gap-2 select-none"
			style={{
				...(showChassis() && style() !== "classic_box"
					? {
							background: chassisTheme().background,
							padding: "10px 14px",
							"border-radius": "18px",
							border: chassisTheme().border,
							"box-shadow": chassisTheme().boxShadow,
							"backdrop-filter": chassisTheme().backdropFilter,
						}
					: {
							padding: "6px",
						}),
			}}
		>
			<For each={keys()}>
				{(key: string, i: () => number) => (
					<SingleKeycap
						keyText={key}
						isModifier={i() === 0 && keys().length > 1}
						style={style()}
						theme={theme()}
						scale={scale()}
						is3D={use3D()}
						showChassis={showChassis()}
						customTextColor={props.customTextColor}
						customBgColor={props.customBgColor}
					/>
				)}
			</For>
		</div>
	);
}
