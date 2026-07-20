import type { CSSProperties, ReactNode } from "react";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

export const OG_BLUE = "#4785FF";
export const OG_BLUE_DEEP = "#2E6FF2";
export const OG_BLUE_LIGHT = "#ADC9FF";

// Light-mode UI palette approximating the desktop app's gray scale.
const UI = {
	windowBg: "#FCFCFC",
	rowBg: "#F9FAFB",
	border: "#E2E4E8",
	text: "#1F2329",
	textDim: "#64686F",
	icon: "#8A8F98",
	blueBorder: "#7DA8F5",
	blueBg: "#EDF4FF",
	blueText: "#2F62D4",
	blueIcon: "#3672E8",
	pillBg: "#F1F2F4",
	pillBorder: "#E2E4E8",
};

const flex = (extra: CSSProperties = {}): CSSProperties => ({
	display: "flex",
	...extra,
});

const CloudPuff = ({
	size,
	left,
	top,
	opacity = 1,
}: {
	size: number;
	left: number;
	top: number;
	opacity?: number;
}) => (
	<div
		style={flex({
			position: "absolute",
			left,
			top,
			width: size,
			height: size,
			borderRadius: 9999,
			opacity,
			background:
				"radial-gradient(circle, rgba(255,255,255,0.92) 0%, rgba(255,255,255,0.45) 42%, rgba(255,255,255,0) 68%)",
		})}
	/>
);

const Sparkle = ({
	size,
	left,
	top,
	opacity = 0.9,
}: {
	size: number;
	left: number;
	top: number;
	opacity?: number;
}) => (
	<svg
		role="img"
		aria-label="Sparkle"
		width={size}
		height={size}
		viewBox="0 0 24 24"
		style={{ position: "absolute", left, top, opacity }}
	>
		<path
			d="M12 0 C13.2 8, 16 10.8, 24 12 C16 13.2, 13.2 16, 12 24 C10.8 16, 8 13.2, 0 12 C8 10.8, 10.8 8, 12 0 Z"
			fill="white"
		/>
	</svg>
);

/**
 * The signature Cap sky — blue gradient, soft cloud banks and glints,
 * recreated as pure vectors so the image needs no remote assets.
 */
export const SkyBackground = ({ children }: { children: ReactNode }) => (
	<div
		style={flex({
			width: "100%",
			height: "100%",
			position: "relative",
			fontFamily: "Neue Montreal",
			background: `linear-gradient(178deg, ${OG_BLUE_DEEP} 0%, ${OG_BLUE} 54%, #86B2FF 100%)`,
		})}
	>
		{/* horizon glow */}
		<div
			style={flex({
				position: "absolute",
				top: 0,
				left: 0,
				width: "100%",
				height: "100%",
				background:
					"radial-gradient(circle at 18% 118%, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0) 55%)",
			})}
		/>
		<div
			style={flex({
				position: "absolute",
				top: 0,
				left: 0,
				width: "100%",
				height: "100%",
				background:
					"radial-gradient(circle at 88% -12%, rgba(211,229,255,0.42) 0%, rgba(211,229,255,0) 48%)",
			})}
		/>
		{/* cloud bank, bottom right */}
		<CloudPuff size={560} left={760} top={430} />
		<CloudPuff size={420} left={980} top={380} />
		<CloudPuff size={360} left={640} top={510} opacity={0.9} />
		{/* wisps, top left */}
		<CloudPuff size={300} left={-110} top={-150} opacity={0.85} />
		<CloudPuff size={220} left={130} top={-140} opacity={0.6} />
		{/* mid drift */}
		<CloudPuff size={260} left={430} top={-190} opacity={0.4} />
		<CloudPuff size={300} left={-170} top={420} opacity={0.5} />
		{/* glints */}
		<Sparkle size={34} left={210} top={128} opacity={0.95} />
		<Sparkle size={18} left={306} top={86} opacity={0.7} />
		<Sparkle size={22} left={1096} top={148} opacity={0.85} />
		<Sparkle size={14} left={1042} top={220} opacity={0.6} />
		<Sparkle size={16} left={648} top={64} opacity={0.55} />
		{children}
	</div>
);

// Exact mark geometry from packages/ui LogoBadge/Logo (viewBox 0 0 40 40):
// concentric circles at (20,20), r 16 / 13 / 10. Returned as an array —
// satori drops React fragments nested inside <svg>.
const logoMark = () => [
	<circle key="o" cx="20" cy="20" r="16" fill={OG_BLUE} />,
	<circle key="m" cx="20" cy="20" r="13" fill={OG_BLUE_LIGHT} />,
	<circle key="i" cx="20" cy="20" r="10" fill="white" />,
];

// The drawn "Cap" wordmark path from packages/ui Logo.tsx (viewBox 0 0 120 40).
const WORDMARK_PATH =
	"M58.416 30.448c-5.404 0-9.212-3.864-9.212-10.36 0-6.384 3.668-10.416 9.268-10.416 5.068 0 7.784 2.66 8.624 7.168l-3.808.196c-.476-2.604-2.072-4.2-4.816-4.2-3.388 0-5.488 2.828-5.488 7.252 0 4.48 2.156 7.196 5.46 7.196 2.94 0 4.508-1.708 4.956-4.564l3.808.196c-.784 4.676-3.752 7.532-8.792 7.532zm16.23-.112c-3.137 0-5.209-1.484-5.209-4.088 0-2.576 1.596-3.948 4.872-4.592l4.956-.98c0-2.1-.98-3.192-2.856-3.192-1.764 0-2.716.812-3.052 2.324l-3.668-.168c.588-3.136 2.996-4.928 6.72-4.928 4.256 0 6.44 2.24 6.44 6.216v5.432c0 .812.28 1.036.84 1.036h.476V30c-.224.056-.812.112-1.288.112-1.624 0-2.828-.588-3.136-2.436-.728 1.596-2.632 2.66-5.096 2.66zm.727-2.604c2.38 0 3.892-1.512 3.892-3.78v-.84l-3.864.784c-1.596.308-2.24.98-2.24 2.016 0 1.176.784 1.82 2.212 1.82zM86.874 34.2V15.048h3.444l.056 2.212c.868-1.652 2.52-2.548 4.48-2.548 4.256 0 6.356 3.5 6.356 7.812s-2.128 7.812-6.384 7.812c-1.904 0-3.556-.924-4.368-2.38V34.2h-3.584zm7.112-6.776c2.184 0 3.5-1.82 3.5-4.9s-1.316-4.9-3.5-4.9-3.528 1.652-3.528 4.9 1.316 4.9 3.528 4.9z";

/** The Cap app icon — the real LogoBadge: white rounded square, mark at 80%. */
export const CapAppIcon = ({ size }: { size: number }) => (
	<div
		style={flex({
			width: size,
			height: size,
			borderRadius: Math.round(size * 0.2),
			boxShadow: "0 4px 14px rgba(23,58,128,0.18)",
		})}
	>
		<svg
			role="img"
			aria-label="Cap"
			width={size}
			height={size}
			viewBox="0 0 40 40"
		>
			<rect width="40" height="40" rx="8" fill="white" />
			{logoMark()}
		</svg>
	</div>
);

/** App icon + drawn "Cap" wordmark lockup (the brand OG header). */
export const CapWordmark = ({
	height = 60,
	color = "white",
}: {
	height?: number;
	color?: string;
}) => (
	<div style={flex({ alignItems: "center", gap: Math.round(height * 0.28) })}>
		<CapAppIcon size={height} />
		<svg
			role="img"
			aria-label="Cap"
			width={Math.round((height * 58) / 40)}
			height={height}
			viewBox="46 0 58 40"
		>
			<path fill={color} d={WORDMARK_PATH} />
		</svg>
	</div>
);

/** The in-app logo — bare mark + wordmark, as the main window renders it. */
const CapFullLogo = ({ height, color }: { height: number; color: string }) => (
	<svg
		role="img"
		aria-label="Cap"
		width={Math.round((height * 104) / 40)}
		height={height}
		viewBox="0 0 104 40"
	>
		{logoMark()}
		<path fill={color} d={WORDMARK_PATH} />
	</svg>
);

const Stroke = {
	fill: "none",
	strokeWidth: 2,
	strokeLinecap: "round" as const,
	strokeLinejoin: "round" as const,
};

const MonitorIcon = ({ size, color }: { size: number; color: string }) => (
	<svg
		role="img"
		aria-label="Display"
		width={size}
		height={size}
		viewBox="0 0 24 24"
	>
		<rect
			x="2"
			y="3"
			width="20"
			height="14"
			rx="2"
			{...Stroke}
			stroke={color}
		/>
		<path d="M8 21h8M12 17v4" {...Stroke} stroke={color} />
	</svg>
);

const AppWindowIcon = ({ size, color }: { size: number; color: string }) => (
	<svg
		role="img"
		aria-label="Window"
		width={size}
		height={size}
		viewBox="0 0 24 24"
	>
		<rect
			x="2"
			y="4"
			width="20"
			height="16"
			rx="2"
			{...Stroke}
			stroke={color}
		/>
		<path d="M2 9h20" {...Stroke} stroke={color} />
		<path d="M5 6.5h.01M8 6.5h.01" {...Stroke} stroke={color} />
	</svg>
);

const AreaIcon = ({ size, color }: { size: number; color: string }) => (
	<svg
		role="img"
		aria-label="Area"
		width={size}
		height={size}
		viewBox="0 0 24 24"
	>
		<path d="M3 8V5a2 2 0 0 1 2-2h3" {...Stroke} stroke={color} />
		<path d="M16 3h3a2 2 0 0 1 2 2v3" {...Stroke} stroke={color} />
		<path d="M21 16v3a2 2 0 0 1-2 2h-3" {...Stroke} stroke={color} />
		<path d="M8 21H5a2 2 0 0 1-2-2v-3" {...Stroke} stroke={color} />
		<rect x="8" y="8" width="8" height="8" rx="1" {...Stroke} stroke={color} />
	</svg>
);

const VideoIcon = ({ size, color }: { size: number; color: string }) => (
	<svg
		role="img"
		aria-label="Camera"
		width={size}
		height={size}
		viewBox="0 0 24 24"
	>
		<path
			d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"
			{...Stroke}
			stroke={color}
		/>
		<rect
			x="2"
			y="6"
			width="14"
			height="12"
			rx="2"
			{...Stroke}
			stroke={color}
		/>
	</svg>
);

const MicIcon = ({ size, color }: { size: number; color: string }) => (
	<svg
		role="img"
		aria-label="Microphone"
		width={size}
		height={size}
		viewBox="0 0 24 24"
	>
		<path
			d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"
			{...Stroke}
			stroke={color}
		/>
		<path d="M19 10v2a7 7 0 0 1-14 0v-2" {...Stroke} stroke={color} />
		<path d="M12 19v3" {...Stroke} stroke={color} />
	</svg>
);

const ChevronDown = ({ size, color }: { size: number; color: string }) => (
	<svg
		role="img"
		aria-label="Open"
		width={size}
		height={size}
		viewBox="0 0 24 24"
	>
		<path d="m6 9 6 6 6-6" {...Stroke} stroke={color} />
	</svg>
);

const GearIcon = ({ size, color }: { size: number; color: string }) => (
	<svg
		role="img"
		aria-label="Settings"
		width={size}
		height={size}
		viewBox="0 0 24 24"
	>
		<circle cx="12" cy="12" r="3" {...Stroke} stroke={color} />
		<path
			d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
			{...Stroke}
			stroke={color}
		/>
	</svg>
);

const ImageIcon = ({ size, color }: { size: number; color: string }) => (
	<svg
		role="img"
		aria-label="Screenshots"
		width={size}
		height={size}
		viewBox="0 0 24 24"
	>
		<rect
			x="3"
			y="3"
			width="18"
			height="18"
			rx="2"
			{...Stroke}
			stroke={color}
		/>
		<circle cx="9" cy="9" r="2" {...Stroke} stroke={color} />
		<path
			d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"
			{...Stroke}
			stroke={color}
		/>
	</svg>
);

const SquarePlayIcon = ({ size, color }: { size: number; color: string }) => (
	<svg
		role="img"
		aria-label="Recordings"
		width={size}
		height={size}
		viewBox="0 0 24 24"
	>
		<rect
			x="3"
			y="3"
			width="18"
			height="18"
			rx="2"
			{...Stroke}
			stroke={color}
		/>
		<path d="m10 8 5 4-5 4Z" {...Stroke} stroke={color} />
	</svg>
);

const Maximize2Icon = ({ size, color }: { size: number; color: string }) => (
	<svg
		role="img"
		aria-label="Expand"
		width={size}
		height={size}
		viewBox="0 0 24 24"
	>
		<path
			d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"
			{...Stroke}
			stroke={color}
		/>
	</svg>
);

/** Lightning bolt from the app's Instant-mode icon. */
const InstantBolt = ({ height, color }: { height: number; color: string }) => (
	<svg
		role="img"
		aria-label="Instant mode"
		width={Math.round((height * 152) / 223)}
		height={height}
		viewBox="0 0 152 223"
	>
		<path
			fill={color}
			d="M150.167 109.163L53.4283 220.65C52.4032 221.826 51.05 222.613 49.573 222.89C48.0959 223.167 46.5752 222.919 45.2403 222.185C43.9054 221.451 42.8287 220.27 42.1727 218.82C41.5167 217.369 41.317 215.729 41.6038 214.146L54.2661 146.019L4.48901 125.914C3.41998 125.484 2.46665 124.776 1.7142 123.853C0.961745 122.93 0.433602 121.82 0.176954 120.624C-0.0796948 119.428 -0.0568536 118.182 0.243435 116.997C0.543723 115.813 1.1121 114.727 1.8978 113.837L98.6363 2.35043C99.6614 1.17365 101.015 0.387451 102.492 0.110461C103.969 -0.166529 105.489 0.080724 106.824 0.814909C108.159 1.54909 109.236 2.73037 109.892 4.18049C110.548 5.63061 110.748 7.27088 110.461 8.85379L97.7639 77.0554L147.541 97.1322C148.602 97.5652 149.548 98.2727 150.294 99.1922C151.041 100.112 151.566 101.215 151.822 102.404C152.078 103.593 152.058 104.832 151.763 106.011C151.468 107.19 150.908 108.273 150.132 109.163H150.167Z"
		/>
	</svg>
);

const FilmIcon = ({ size, color }: { size: number; color: string }) => (
	<svg
		role="img"
		aria-label="Studio mode"
		width={size}
		height={size}
		viewBox="0 0 24 24"
	>
		<rect
			x="3"
			y="3"
			width="18"
			height="18"
			rx="2"
			{...Stroke}
			stroke={color}
		/>
		<path
			d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4"
			{...Stroke}
			stroke={color}
		/>
	</svg>
);

const ScreenshotModeIcon = ({
	size,
	color,
}: {
	size: number;
	color: string;
}) => (
	<svg
		role="img"
		aria-label="Screenshot mode"
		width={size}
		height={size}
		viewBox="0 0 24 24"
	>
		<path
			fill={color}
			d="M21 2H3a1 1 0 0 0-1 1v18a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1ZM20 14l-3-3-5 5-2-2-6 6V4h16ZM6 8.5A2.5 2.5 0 1 1 8.5 11 2.5 2.5 0 0 1 6 8.5Z"
		/>
	</svg>
);

const TrafficLights = () => (
	<div style={flex({ gap: 9, alignItems: "center" })}>
		<div
			style={flex({
				width: 13,
				height: 13,
				borderRadius: 9999,
				background: "#FF5F57",
			})}
		/>
		<div
			style={flex({
				width: 13,
				height: 13,
				borderRadius: 9999,
				background: "#FEBC2E",
			})}
		/>
		<div
			style={flex({
				width: 13,
				height: 13,
				borderRadius: 9999,
				background: "#28C840",
			})}
		/>
	</div>
);

const ModeSwitcher = () => (
	<div
		style={flex({
			position: "relative",
			alignItems: "center",
			gap: 9,
			padding: 7,
			borderRadius: 999,
			border: `1px solid ${UI.pillBorder}`,
			background: UI.pillBg,
		})}
	>
		<div
			style={flex({
				position: "absolute",
				left: -6,
				top: -8,
				width: 15,
				height: 15,
				borderRadius: 9999,
				background: "#E0E2E5",
				alignItems: "center",
				justifyContent: "center",
				fontSize: 9,
				fontWeight: 700,
				color: UI.textDim,
			})}
		>
			i
		</div>
		{/* Instant — selected: disc with blue ring */}
		<div
			style={flex({
				width: 34,
				height: 34,
				borderRadius: 9999,
				border: `2px solid ${OG_BLUE}`,
				background: "#CDCFD3",
				alignItems: "center",
				justifyContent: "center",
			})}
		>
			<InstantBolt height={16} color="#1F2329" />
		</div>
		<div
			style={flex({
				width: 34,
				height: 34,
				borderRadius: 9999,
				alignItems: "center",
				justifyContent: "center",
			})}
		>
			<FilmIcon size={16} color="#1F2329" />
		</div>
		<div
			style={flex({
				width: 34,
				height: 34,
				borderRadius: 9999,
				alignItems: "center",
				justifyContent: "center",
			})}
		>
			<ScreenshotModeIcon size={15} color="#1F2329" />
		</div>
	</div>
);

const TargetSplitButton = ({
	icon,
	label,
	selected,
}: {
	icon: ReactNode;
	label: string;
	selected?: boolean;
}) => (
	<div
		style={flex({
			flexGrow: 1,
			flexBasis: 0,
			borderRadius: 10,
			border: `1px solid ${selected ? UI.blueBorder : UI.border}`,
			background: selected ? UI.blueBg : UI.rowBg,
			overflow: "hidden",
		})}
	>
		<div
			style={flex({
				flexGrow: 1,
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: 5,
				padding: "10px 0 9px",
			})}
		>
			{icon}
			<span
				style={{
					fontSize: 14,
					fontWeight: 500,
					color: selected ? UI.blueText : UI.text,
				}}
			>
				{label}
			</span>
		</div>
		<div
			style={flex({
				width: 30,
				alignItems: "center",
				justifyContent: "center",
				borderLeft: `1px solid ${selected ? "#B9D0F8" : UI.border}`,
			})}
		>
			<ChevronDown size={15} color={selected ? UI.blueIcon : UI.icon} />
		</div>
	</div>
);

const TargetButton = ({ icon, label }: { icon: ReactNode; label: string }) => (
	<div
		style={flex({
			flexGrow: 1,
			flexBasis: 0,
			flexDirection: "column",
			alignItems: "center",
			justifyContent: "center",
			gap: 5,
			padding: "10px 0 9px",
			borderRadius: 10,
			border: `1px solid ${UI.border}`,
			background: UI.rowBg,
		})}
	>
		{icon}
		<span style={{ fontSize: 14, fontWeight: 500, color: UI.text }}>
			{label}
		</span>
	</div>
);

const DeviceRow = ({
	icon,
	label,
	trailing,
}: {
	icon: ReactNode;
	label: string;
	trailing: ReactNode;
}) => (
	<div
		style={flex({
			alignItems: "center",
			gap: 12,
			height: 50,
			paddingLeft: 14,
			paddingRight: 10,
			borderRadius: 10,
			border: `1px solid ${UI.border}`,
			background: UI.rowBg,
		})}
	>
		{icon}
		<span
			style={{
				flexGrow: 1,
				fontSize: 16,
				fontWeight: 500,
				color: UI.text,
			}}
		>
			{label}
		</span>
		{trailing}
	</div>
);

/** Miniature of the actual Cap main window (new-main, light mode). */
export const RecorderCard = ({ width = 380 }: { width?: number }) => (
	<div
		style={flex({
			width,
			flexDirection: "column",
			background: UI.windowBg,
			borderRadius: 16,
			padding: "14px 16px 16px",
			gap: 11,
			boxShadow: "0 30px 60px rgba(20,52,120,0.35)",
		})}
	>
		{/* window chrome */}
		<div style={flex({ alignItems: "center" })}>
			<TrafficLights />
			<div style={flex({ flexGrow: 1 })} />
			<div style={flex({ gap: 11, alignItems: "center" })}>
				<Maximize2Icon size={15} color={UI.icon} />
				<GearIcon size={17} color={UI.icon} />
				<ImageIcon size={17} color={UI.icon} />
				<SquarePlayIcon size={17} color={UI.icon} />
			</div>
		</div>
		{/* logo row + mode switcher */}
		<div style={flex({ alignItems: "center", marginTop: 4 })}>
			<CapFullLogo height={30} color="#12161F" />
			<div
				style={flex({
					marginLeft: 8,
					padding: "3px 8px",
					borderRadius: 8,
					border: `1px solid ${UI.pillBorder}`,
					background: UI.pillBg,
					fontSize: 11,
					fontWeight: 500,
					color: UI.textDim,
				})}
			>
				Personal
			</div>
			<div style={flex({ flexGrow: 1 })} />
			<ModeSwitcher />
		</div>
		{/* capture targets */}
		<div style={flex({ gap: 9, marginTop: 2 })}>
			<TargetSplitButton
				selected
				icon={<MonitorIcon size={22} color={UI.blueIcon} />}
				label="Display"
			/>
			<TargetSplitButton
				icon={<AppWindowIcon size={22} color={UI.icon} />}
				label="Window"
			/>
		</div>
		<div style={flex({ gap: 9 })}>
			<TargetButton
				icon={<AreaIcon size={22} color={UI.icon} />}
				label="Area"
			/>
			<TargetButton
				icon={<VideoIcon size={22} color={UI.icon} />}
				label="Camera Only"
			/>
		</div>
		{/* devices */}
		<DeviceRow
			icon={<VideoIcon size={19} color={UI.textDim} />}
			label="MacBook Pro Camera"
			trailing={<ChevronDown size={16} color={UI.icon} />}
		/>
		<DeviceRow
			icon={<MicIcon size={19} color={UI.textDim} />}
			label="MacBook Pro Microphone"
			trailing={<ChevronDown size={16} color={UI.icon} />}
		/>
		<DeviceRow
			icon={<MonitorIcon size={19} color={UI.textDim} />}
			label="Record System Audio"
			trailing={
				<div
					style={flex({
						alignItems: "center",
						justifyContent: "center",
						minWidth: 44,
						height: 26,
						padding: "0 12px",
						borderRadius: 999,
						background: OG_BLUE,
						fontSize: 12,
						fontWeight: 500,
						color: "white",
					})}
				>
					On
				</div>
			}
		/>
	</div>
);

/** Pill chip used for page categories ("Pricing", "Blog", …). */
export const TagChip = ({ label }: { label: string }) => (
	<div
		style={flex({
			alignItems: "center",
			alignSelf: "flex-start",
			background: "rgba(255,255,255,0.16)",
			border: "1px solid rgba(255,255,255,0.38)",
			borderRadius: 999,
			padding: "7px 20px",
			fontSize: 21,
			fontWeight: 500,
			color: "white",
		})}
	>
		{label}
	</div>
);

export const titleFontSize = (title: string) => {
	if (title.length <= 24) return 76;
	if (title.length <= 48) return 62;
	if (title.length <= 72) return 52;
	return 44;
};
