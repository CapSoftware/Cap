import type { CSSProperties } from "react";
import {
	LOOM_MARK_PATH,
	LoopSparks,
	SceneCursor,
	SceneRipple,
	Sparks,
} from "./paper";

const white = { fill: "#fff" } as const;
const paper2 = { fill: "var(--ob-paper-2)" } as const;

const PlayTriangle = ({
	x,
	y,
	size = 1,
	color = "var(--ob-ink-faint)",
}: {
	x: number;
	y: number;
	size?: number;
	color?: string;
}) => (
	<path
		d={`M ${x - 3 * size} ${y - 4 * size} L ${x + 4.5 * size} ${y} L ${x - 3 * size} ${y + 4 * size} Z`}
		fill={color}
	/>
);

export const LoomScene = () => (
	<svg viewBox="0 0 360 220" className="ob-scene" aria-hidden="true">
		<g className="ob-boil">
			<rect
				x="12"
				y="24"
				width="160"
				height="150"
				rx="12"
				className="ob-ink"
				style={white}
			/>
			<path d="M 12 50 L 172 50" className="ob-ink is-track" />
			<rect
				x="24"
				y="60"
				width="136"
				height="74"
				rx="8"
				className="ob-ink is-loom"
				style={{ fill: "var(--ob-loom-soft)" }}
			/>
			<rect
				className="ob-ink ob-press"
				x="24"
				y="144"
				width="78"
				height="22"
				rx="11"
				style={{ ...white, "--at": 0.15 } as CSSProperties}
			/>
			<rect
				x="188"
				y="24"
				width="160"
				height="150"
				rx="12"
				className="ob-ink"
				style={white}
			/>
			<path d="M 188 50 L 348 50" className="ob-ink is-track" />
			<rect
				x="200"
				y="58"
				width="136"
				height="26"
				rx="8"
				className="ob-ink is-track"
				style={white}
			/>
			<rect
				x="200"
				y="138"
				width="40"
				height="28"
				rx="6"
				className="ob-ink is-track"
				style={paper2}
			/>
			<rect
				x="248"
				y="138"
				width="40"
				height="28"
				rx="6"
				className="ob-ink is-track"
				style={paper2}
			/>
			<rect
				x="296"
				y="138"
				width="40"
				height="28"
				rx="6"
				className="ob-ink is-track"
				style={{ strokeDasharray: "3 4" }}
			/>
		</g>

		<circle cx="26" cy="37" r="2.4" fill="var(--ob-ink-faint)" />
		<circle cx="35" cy="37" r="2.4" fill="var(--ob-ink-faint)" />
		<circle cx="44" cy="37" r="2.4" fill="var(--ob-ink-faint)" />
		<rect x="58" y="30" width="78" height="14" rx="7" style={paper2} />
		<text
			x="97"
			y="40.2"
			fontSize="8.5"
			textAnchor="middle"
			className="ob-label is-soft"
		>
			loom.com
		</text>
		<path
			d={LOOM_MARK_PATH}
			transform="translate(32 67) scale(0.8)"
			fill="var(--ob-loom)"
		/>
		<path
			d="M 86 88 L 102 97 L 86 106 Z"
			fill="var(--ob-loom)"
			opacity="0.85"
		/>

		<g className="ob-press" style={{ "--at": 0.15 } as CSSProperties}>
			<text
				x="63"
				y="158.6"
				fontSize="9.5"
				textAnchor="middle"
				fontWeight="500"
				className="ob-label ob-loom-copy-label"
			>
				Copy link
			</text>
			<g className="ob-loom-copied-label">
				<path d="M 41 155 L 44.5 158.5 L 50 152" className="ob-ink is-green" />
				<text
					x="54"
					y="158.6"
					fontSize="9.5"
					fontWeight="500"
					fill="var(--ob-green)"
				>
					Copied
				</text>
			</g>
		</g>

		<circle cx="204" cy="37" r="6.5" fill="var(--ob-accent)" />
		<circle cx="204" cy="37" r="4.2" fill="#ADC9FF" />
		<circle cx="204" cy="37" r="2.8" fill="#fff" />
		<text x="215" y="40.5" fontSize="10" fontWeight="500" className="ob-label">
			Cap
		</text>

		<rect
			className="ob-loom-input-focus"
			x="200"
			y="58"
			width="136"
			height="26"
			rx="8"
			fill="none"
			stroke="var(--ob-accent)"
			strokeWidth="2"
		/>
		<text
			x="209"
			y="74.4"
			fontSize="9"
			className="ob-label is-faint ob-loom-placeholder"
		>
			Paste a Loom link
		</text>
		<text x="209" y="74.4" fontSize="9" className="ob-label">
			loom.com/share/7f3a2c…
		</text>
		<rect
			className="ob-loom-typed-cover ob-tf-right"
			x="207"
			y="62"
			width="125"
			height="18"
			fill="#fff"
		/>

		<g className="ob-press" style={{ "--at": 0.61 } as CSSProperties}>
			<rect
				x="276"
				y="92"
				width="60"
				height="22"
				rx="11"
				fill="var(--ob-ink)"
			/>
			<text
				x="306"
				y="106.4"
				fontSize="9.5"
				fontWeight="500"
				textAnchor="middle"
				className="ob-label is-paper"
			>
				Import
			</text>
		</g>

		<text
			x="200"
			y="131"
			fontSize="9"
			fontWeight="500"
			className="ob-label is-soft"
		>
			My Caps
		</text>
		<PlayTriangle x={220} y={152} size={0.9} />
		<PlayTriangle x={268} y={152} size={0.9} />
		<g className="ob-loom-slot-fill">
			<rect
				x="296"
				y="138"
				width="40"
				height="28"
				rx="6"
				fill="var(--ob-loom-soft)"
				stroke="var(--ob-loom)"
				strokeWidth="1.6"
			/>
			<path
				pathLength={1}
				className="ob-ink is-green is-bold ob-loom-check"
				d="M 307 152 L 313 158 L 325 145"
			/>
		</g>
		<LoopSparks
			at={0.87}
			points={[
				[290, 132, 3],
				[344, 138, 3.2],
				[340, 174, 2.6],
			]}
		/>

		<path
			className="ob-ink is-soft ob-loom-trail"
			d="M 92 97 C 150 14 262 12 316 152"
		/>
		<g className="ob-loom-flyer">
			<rect
				x="-20"
				y="-14"
				width="40"
				height="28"
				rx="6"
				fill="#efeefe"
				stroke="var(--ob-loom)"
				strokeWidth="1.6"
			/>
			<path
				d={LOOM_MARK_PATH}
				transform="translate(-16 -10) scale(0.45)"
				fill="var(--ob-loom)"
			/>
			<path d="M -3 -5 L 6 0 L -3 5 Z" fill="var(--ob-loom)" />
		</g>

		<SceneRipple x={60} y={156} at={0.15} />
		<SceneRipple x={262} y={71} at={0.43} />
		<SceneRipple x={306} y={103} at={0.61} />
		<SceneCursor name="ob-loom-cursor" />
	</svg>
);

const SOURCE_GLYPHS = [
	{
		label: "Screen",
		color: "var(--ob-screen)",
		glyph: "M -5.5 -4 L 5.5 -4 L 5.5 3 L -5.5 3 Z M -2.5 5.8 L 2.5 5.8",
	},
	{
		label: "Camera",
		color: "var(--ob-camera)",
		glyph:
			"M -5.5 -2.8 L -2.8 -2.8 L -1.6 -4.8 L 1.6 -4.8 L 2.8 -2.8 L 5.5 -2.8 L 5.5 4.8 L -5.5 4.8 Z M 0 -0.6 m -2 0 a 2 2 0 1 0 4 0 a 2 2 0 1 0 -4 0",
	},
	{
		label: "Mic",
		color: "var(--ob-mic)",
		glyph:
			"M -2 -5.6 L 2 -5.6 L 2 0.8 Q 2 2.8 0 2.8 Q -2 2.8 -2 0.8 Z M -4.4 0 Q -4.4 4.8 0 4.8 Q 4.4 4.8 4.4 0 M 0 4.8 L 0 6.8",
	},
] as const;

const MIC_BARS = Array.from({ length: 16 }, (_, index) => ({
	id: `bar-${index}`,
	x: 30 + index * 12,
	j: index % 7,
}));

export const RecordScene = () => (
	<svg viewBox="0 0 360 220" className="ob-scene" aria-hidden="true">
		<g className="ob-boil">
			<rect
				x="18"
				y="26"
				width="208"
				height="128"
				rx="10"
				className="ob-ink"
				style={white}
			/>
			<path
				d="M 108 154 L 104 170 M 136 154 L 140 170 M 92 172 L 152 172"
				className="ob-ink"
			/>
			<rect
				x="150"
				y="40"
				width="62"
				height="48"
				rx="6"
				className="ob-ink is-track"
			/>
			<path
				d="M 156 78 L 168 66 L 178 72 L 192 54 L 206 60"
				className="ob-ink is-accent"
				style={{ strokeWidth: 1.8 }}
			/>
			{SOURCE_GLYPHS.map((source, index) => (
				<rect
					key={source.label}
					x="240"
					y={30 + index * 36}
					width="106"
					height="28"
					rx="9"
					className="ob-ink"
					style={white}
				/>
			))}
		</g>

		<rect x="32" y="40" width="56" height="7" rx="3.5" fill="var(--ob-track)" />
		<rect x="32" y="57" width="104" height="5" rx="2.5" style={paper2} />
		<rect x="32" y="68" width="84" height="5" rx="2.5" style={paper2} />
		<rect x="32" y="79" width="96" height="5" rx="2.5" style={paper2} />
		<rect x="32" y="96" width="110" height="5" rx="2.5" style={paper2} />

		{SOURCE_GLYPHS.map((source, index) => {
			const y = 30 + index * 36;
			const n = index + 1;
			return (
				<g key={source.label}>
					<rect
						x="248"
						y={y + 6}
						width="16"
						height="16"
						rx="5"
						fill={`color-mix(in srgb, ${source.color} 18%, transparent)`}
					/>
					<path
						d={source.glyph}
						transform={`translate(256 ${y + 14}) scale(0.85)`}
						fill="none"
						stroke={source.color}
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<text
						x="271"
						y={y + 17.4}
						fontSize="9.5"
						fontWeight="500"
						className="ob-label"
					>
						{source.label}
					</text>
					<rect
						x="316"
						y={y + 8}
						width="22"
						height="12"
						rx="6"
						className="ob-rec-switch"
						style={
							{
								"--switch": `ob-rec-switch-${n}`,
							} as CSSProperties
						}
					/>
					<circle
						cx="322"
						cy={y + 14}
						r="4.3"
						fill="#fff"
						className="ob-rec-knob"
						style={{ "--knob": `ob-rec-knob-${n}` } as CSSProperties}
					/>
				</g>
			);
		})}

		<g
			className="ob-rec-start ob-press"
			style={{ "--at": 0.38 } as CSSProperties}
		>
			<rect
				x="240"
				y="146"
				width="106"
				height="28"
				rx="14"
				fill="var(--ob-red)"
			/>
			<circle cx="266" cy="160" r="4.5" fill="#fff" />
			<text
				x="276"
				y="163.6"
				fontSize="10"
				fontWeight="500"
				className="ob-label is-paper"
			>
				Record
			</text>
		</g>
		<g
			className="ob-rec-stop ob-press"
			style={{ "--at": 0.7 } as CSSProperties}
		>
			<rect
				x="240"
				y="146"
				width="106"
				height="28"
				rx="14"
				fill="var(--ob-ink)"
			/>
			<rect x="262" y="156" width="8" height="8" rx="1.6" fill="#fff" />
			<text
				x="276"
				y="163.6"
				fontSize="10"
				fontWeight="500"
				className="ob-label is-paper"
			>
				Stop
			</text>
		</g>

		<g className="ob-rec-live">
			<rect
				x="23"
				y="31"
				width="198"
				height="118"
				rx="7"
				fill="none"
				stroke="var(--ob-red)"
				strokeWidth="1.6"
				strokeDasharray="5 4"
			/>
			<circle
				cx="35"
				cy="139"
				r="4"
				fill="var(--ob-red)"
				className="ob-pulse"
			/>
			{["0:01", "0:02", "0:03"].map((time, index) => (
				<text
					key={time}
					x="44"
					y="142.4"
					fontSize="9"
					fontWeight="500"
					className={
						index === 2
							? "ob-label ob-rec-time is-last"
							: "ob-label ob-rec-time"
					}
					style={{ "--at": 0.4 + index * 0.08 } as CSSProperties}
				>
					{time}
				</text>
			))}
			<rect
				x="18"
				y="184"
				width="208"
				height="20"
				rx="7"
				fill="color-mix(in srgb, var(--ob-mic) 16%, transparent)"
			/>
			{MIC_BARS.map((bar) => (
				<rect
					key={bar.id}
					className="ob-rec-bar"
					x={bar.x}
					y="188"
					width="3.2"
					height="12"
					rx="1.6"
					fill="var(--ob-mic)"
					style={{ "--j": bar.j } as CSSProperties}
				/>
			))}
		</g>

		<g className="ob-rec-cam ob-tf">
			<g className="ob-bob">
				<circle
					cx="196"
					cy="122"
					r="19"
					fill="color-mix(in srgb, var(--ob-camera) 18%, #fff)"
					stroke="var(--ob-camera)"
					strokeWidth="1.8"
				/>
				<circle cx="190" cy="118" r="1.8" fill="var(--ob-ink)" />
				<circle cx="202" cy="118" r="1.8" fill="var(--ob-ink)" />
				<path d="M 189 126 Q 196 132 203 126" className="ob-ink" />
			</g>
		</g>

		<g className="ob-rec-link ob-tf">
			<g className="ob-boil">
				<rect
					x="40"
					y="58"
					width="158"
					height="62"
					rx="12"
					className="ob-ink"
					style={white}
				/>
			</g>
			<circle cx="64" cy="89" r="12" fill="var(--ob-accent)" />
			<path
				d="M 60.5 92.5 L 67.5 85.5 M 58.6 89 l -1.8 1.8 a 3.4 3.4 0 0 0 4.8 4.8 l 1.8 -1.8 M 69.4 89 l 1.8 -1.8 a 3.4 3.4 0 0 0 -4.8 -4.8 l -1.8 1.8"
				fill="none"
				stroke="#fff"
				strokeWidth="1.8"
				strokeLinecap="round"
			/>
			<text x="84" y="84.5" fontSize="10" fontWeight="500" className="ob-label">
				Your link is ready
			</text>
			<text x="84" y="99" fontSize="9" className="ob-label is-soft">
				cap.link/x7k2
			</text>
			<g className="ob-press" style={{ "--at": 0.86 } as CSSProperties}>
				<rect
					x="150"
					y="91"
					width="40"
					height="18"
					rx="9"
					fill="#fff"
					stroke="var(--ob-ink)"
					strokeWidth="1.4"
				/>
				<text
					x="170"
					y="103.2"
					fontSize="8.5"
					fontWeight="500"
					textAnchor="middle"
					className="ob-label"
				>
					Copy
				</text>
			</g>
		</g>
		<LoopSparks
			at={0.76}
			points={[
				[34, 52, 3.4],
				[206, 56, 3],
				[204, 126, 2.6],
			]}
		/>

		<SceneRipple x={327} y={44} at={0.17} />
		<SceneRipple x={327} y={80} at={0.255} />
		<SceneRipple x={327} y={116} at={0.31} />
		<SceneRipple x={293} y={160} at={0.38} />
		<SceneRipple x={293} y={160} at={0.7} />
		<SceneRipple x={170} y={100} at={0.86} />
		<SceneCursor name="ob-rec-cursor" />
	</svg>
);

const UPLOAD_SQUIGGLE =
	"M 172 112 q 6 -7 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0";

export const UploadScene = () => (
	<svg viewBox="0 0 360 220" className="ob-scene" aria-hidden="true">
		<g className="ob-boil">
			<rect
				x="140"
				y="28"
				width="204"
				height="164"
				rx="16"
				className="ob-ink is-soft"
				style={{ fill: "rgba(255,255,255,0.65)", strokeDasharray: "7 7" }}
			/>
		</g>
		<rect
			className="ob-up-zone-hot"
			x="140"
			y="28"
			width="204"
			height="164"
			rx="16"
			fill="rgba(71,133,255,0.07)"
			stroke="var(--ob-accent)"
			strokeWidth="2"
			strokeDasharray="7 7"
		/>

		<g className="ob-up-zone-hint">
			<g className="ob-boil">
				<path
					d="M 242 98 L 242 70 M 230 82 L 242 69 L 254 82"
					className="ob-ink is-accent is-bold"
				/>
				<path
					d="M 222 104 L 222 110 Q 222 114 226 114 L 258 114 Q 262 114 262 110 L 262 104"
					className="ob-ink"
				/>
			</g>
			<text
				x="242"
				y="138"
				fontSize="10"
				textAnchor="middle"
				className="ob-label is-soft"
			>
				Drop a video
			</text>
		</g>

		<g className="ob-up-progress-group">
			<text
				x="242"
				y="94"
				fontSize="9.5"
				textAnchor="middle"
				className="ob-label is-soft"
			>
				Uploading
			</text>
			<path
				className="ob-squiggle-track"
				pathLength={100}
				d={UPLOAD_SQUIGGLE}
			/>
			<path
				className="ob-up-progress"
				pathLength={100}
				d={UPLOAD_SQUIGGLE}
				fill="none"
				stroke="var(--ob-accent)"
				strokeWidth="3.2"
				strokeLinecap="round"
			/>
		</g>

		<g className="ob-up-done ob-tf">
			<g className="ob-boil">
				<rect
					x="166"
					y="92"
					width="152"
					height="36"
					rx="18"
					className="ob-ink"
					style={white}
				/>
			</g>
			<circle cx="186" cy="110" r="10" fill="var(--ob-green)" />
			<path
				d="M 181.5 110 L 185 113.5 L 191 106.5"
				fill="none"
				stroke="#fff"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<text
				x="203"
				y="113.6"
				fontSize="10"
				fontWeight="500"
				className="ob-label"
			>
				cap.link/q4m9
			</text>
			<text
				x="242"
				y="150"
				fontSize="9.5"
				textAnchor="middle"
				className="ob-label is-soft"
			>
				Ready to share
			</text>
		</g>
		<LoopSparks
			at={0.72}
			points={[
				[160, 84, 3.2],
				[328, 90, 3],
				[322, 138, 2.6],
			]}
		/>

		<g className="ob-up-file">
			<g className="ob-boil">
				<path
					d="M -22 -30 L 10 -30 L 22 -18 L 22 30 L -22 30 Z"
					className="ob-ink"
					style={white}
				/>
				<path d="M 10 -30 L 10 -18 L 22 -18" className="ob-ink" />
			</g>
			<path
				d="M -6 -7 L 8 1 L -6 9 Z"
				fill="var(--ob-accent-soft)"
				stroke="var(--ob-accent)"
				strokeWidth="1.6"
				strokeLinejoin="round"
			/>
			<text
				x="0"
				y="44"
				fontSize="8.5"
				textAnchor="middle"
				className="ob-label is-soft"
			>
				demo.mp4
			</text>
		</g>

		<SceneRipple x={66} y={124} at={0.05} />
		<SceneRipple x={252} y={120} at={0.31} r={16} />
		<SceneCursor name="ob-up-cursor" />
	</svg>
);

const TEAM = [
	{ initial: "A", fill: "#ffe7d1" },
	{ initial: "M", fill: "#dbe8ff" },
	{ initial: "J", fill: "#dcf5e5" },
] as const;

const LIBRARY = Array.from({ length: 6 }, (_, index) => ({
	id: `thumb-${index}`,
	x: 214 + (index % 3) * 44,
	y: index < 3 ? 110 : 148,
	highlight: index === 5,
	j: index,
}));

const truncate = (value: string, max: number) =>
	value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

export const JoinScene = ({
	organizationName,
	initial,
}: {
	organizationName: string;
	initial: string;
}) => (
	<svg viewBox="0 0 360 220" className="ob-scene" aria-hidden="true">
		<g className="ob-boil">
			<path
				className="ob-ink ob-join-flap-open"
				d="M 40 114 L 110 74 L 180 114"
				style={white}
			/>
		</g>

		<g className="ob-join-card">
			<g className="ob-boil">
				<rect
					x="52"
					y="30"
					width="116"
					height="78"
					rx="10"
					className="ob-ink"
					style={white}
				/>
			</g>
			<circle
				cx="72"
				cy="52"
				r="10"
				fill="var(--ob-accent-soft)"
				stroke="var(--ob-accent)"
				strokeWidth="1.4"
			/>
			<text
				x="72"
				y="55.6"
				fontSize="10"
				fontWeight="500"
				textAnchor="middle"
				fill="var(--ob-accent)"
			>
				{organizationName.trim().charAt(0).toUpperCase() || "C"}
			</text>
			<text x="88" y="51" fontSize="9.5" fontWeight="500" className="ob-label">
				{truncate(organizationName, 13)}
			</text>
			<text x="88" y="63" fontSize="8.5" className="ob-label is-soft">
				on Cap
			</text>
			<g className="ob-press" style={{ "--at": 0.27 } as CSSProperties}>
				<rect
					x="66"
					y="76"
					width="88"
					height="22"
					rx="11"
					fill="var(--ob-ink)"
				/>
				<text
					x="110"
					y="90.4"
					fontSize="9.5"
					fontWeight="500"
					textAnchor="middle"
					className="ob-label is-paper"
				>
					Join
				</text>
			</g>
		</g>

		<g className="ob-boil">
			<rect
				x="40"
				y="112"
				width="140"
				height="80"
				rx="8"
				className="ob-ink"
				style={white}
			/>
			<path
				d="M 40 190 L 98 150 M 180 190 L 122 150"
				className="ob-ink is-track"
			/>
			<path
				className="ob-ink ob-join-flap-closed"
				d="M 42 116 L 110 158 L 178 116"
			/>
			{TEAM.map((member, index) => (
				<circle
					key={member.initial}
					cx={222 + index * 28}
					cy="56"
					r="13"
					className="ob-ink"
					style={{ fill: member.fill }}
				/>
			))}
			{LIBRARY.map((thumb) => (
				<rect
					key={thumb.id}
					className="ob-ink ob-join-thumb ob-tf"
					x={thumb.x}
					y={thumb.y}
					width="38"
					height="30"
					rx="6"
					style={
						{
							fill: thumb.highlight
								? "var(--ob-accent-soft)"
								: "var(--ob-paper-2)",
							stroke: thumb.highlight ? "var(--ob-accent)" : undefined,
							"--j": thumb.j,
						} as CSSProperties
					}
				/>
			))}
		</g>

		{TEAM.map((member, index) => (
			<text
				key={member.initial}
				x={222 + index * 28}
				y="59.6"
				fontSize="10"
				fontWeight="500"
				textAnchor="middle"
				className="ob-label"
			>
				{member.initial}
			</text>
		))}
		<g className="ob-join-you ob-tf">
			<circle
				cx="306"
				cy="56"
				r="13"
				fill="var(--ob-accent)"
				stroke="var(--ob-ink)"
				strokeWidth="2"
			/>
			<text
				x="306"
				y="59.6"
				fontSize="10"
				fontWeight="500"
				textAnchor="middle"
				className="ob-label is-paper"
			>
				{initial}
			</text>
		</g>
		<g className="ob-join-you-label">
			<path d="M 233 85 L 236.5 88.5 L 242 82" className="ob-ink is-green" />
			<text x="247" y="89" fontSize="9.5" fontWeight="500" className="ob-label">
				You're in the team
			</text>
		</g>
		<LoopSparks
			at={0.42}
			points={[
				[300, 30, 3],
				[332, 42, 3],
				[330, 76, 2.6],
			]}
		/>
		{LIBRARY.map((thumb) => (
			<g
				key={thumb.id}
				className="ob-join-thumb ob-tf"
				style={{ "--j": thumb.j } as CSSProperties}
			>
				<PlayTriangle
					x={thumb.x + 19}
					y={thumb.y + 15}
					size={0.8}
					color={thumb.highlight ? "var(--ob-accent)" : "var(--ob-ink-faint)"}
				/>
			</g>
		))}
		<circle cx="346" cy="150" r="3" fill="var(--ob-red)" className="ob-pulse" />
		<text
			x="214"
			y="200"
			fontSize="9"
			fontWeight="500"
			className="ob-label is-soft"
		>
			Team library
		</text>

		<SceneRipple x={110} y={87} at={0.27} />
		<SceneCursor name="ob-join-cursor" />
	</svg>
);

export const LoomToCapDoodle = () => (
	<svg
		viewBox="0 0 120 90"
		className="h-auto w-full overflow-visible"
		aria-hidden="true"
	>
		<path
			d={LOOM_MARK_PATH}
			transform="translate(10 30) scale(1.9)"
			fill="var(--ob-loom)"
		/>
		<g className="ob-boil">
			<g className="ob-doodle-hover">
				<path
					pathLength={1}
					className="ob-ink is-bold ob-draw"
					style={{ "--d": "0.25s" } as CSSProperties}
					d="M 46 38 C 56 22 70 22 79 35"
				/>
				<path
					pathLength={1}
					className="ob-ink is-bold ob-draw"
					style={{ "--d": "0.8s" } as CSSProperties}
					d="M 70 34 L 79.5 36 L 80 26.5"
				/>
			</g>
		</g>
		<circle cx="97" cy="46" r="15" fill="var(--ob-accent)" />
		<circle cx="97" cy="46" r="10" fill="#ADC9FF" />
		<circle cx="97" cy="46" r="6.5" fill="#fff" />
		<g className="ob-boil">
			<Sparks
				delay={1}
				points={[
					[110, 22, 2.6],
					[116, 66, 2.2],
				]}
			/>
		</g>
	</svg>
);

export const RecordDoodle = () => (
	<svg
		viewBox="0 0 120 90"
		className="h-auto w-full overflow-visible"
		aria-hidden="true"
	>
		<g className="ob-boil">
			<rect
				pathLength={1}
				className="ob-ink is-bold ob-draw"
				x="14"
				y="12"
				width="76"
				height="52"
				rx="7"
			/>
			<path
				pathLength={1}
				className="ob-ink is-bold ob-draw"
				style={{ "--d": "0.5s" } as CSSProperties}
				d="M 46 64 L 43 76 M 58 64 L 61 76 M 36 77 L 68 77"
			/>
		</g>
		<circle cx="28" cy="25" r="4.5" fill="var(--ob-red)" className="ob-pulse" />
		<g className="ob-doodle-hover">
			<g className="ob-bob">
				<circle
					cx="92"
					cy="60"
					r="14"
					fill="color-mix(in srgb, var(--ob-camera) 18%, #fff)"
					stroke="var(--ob-camera)"
					strokeWidth="2.2"
				/>
				<circle cx="87.5" cy="57" r="1.6" fill="var(--ob-ink)" />
				<circle cx="96.5" cy="57" r="1.6" fill="var(--ob-ink)" />
				<path d="M 87 63 Q 92 67 97 63" className="ob-ink" />
			</g>
		</g>
	</svg>
);

export const UploadDoodle = () => (
	<svg
		viewBox="0 0 120 90"
		className="h-auto w-full overflow-visible"
		aria-hidden="true"
	>
		<g className="ob-boil">
			<path
				pathLength={1}
				className="ob-ink is-bold ob-draw"
				d="M 38 10 L 66 10 L 82 26 L 82 80 L 38 80 Z"
			/>
			<path
				pathLength={1}
				className="ob-ink is-bold ob-draw"
				style={{ "--d": "0.5s" } as CSSProperties}
				d="M 66 10 L 66 26 L 82 26"
			/>
			<g className="ob-fade" style={{ "--d": "0.7s" } as CSSProperties}>
				<g className="ob-bob ob-doodle-hover">
					<path
						className="ob-ink is-accent is-bold"
						d="M 60 66 L 60 40 M 50 50 L 60 39 L 70 50"
					/>
				</g>
			</g>
		</g>
	</svg>
);

export const DoneDoodle = () => (
	<svg
		viewBox="0 0 120 104"
		className="h-auto w-24 overflow-visible"
		aria-hidden="true"
	>
		<g className="ob-boil">
			<path
				pathLength={1}
				className="ob-ink is-bold ob-draw"
				style={{ "--d": "0.05s", strokeWidth: 4.5 } as CSSProperties}
				d="M 34 58 L 52 76 L 90 30"
			/>
			<Sparks
				delay={0.55}
				points={[
					[24, 22, 3.2],
					[98, 14, 3.2],
					[104, 64, 2.6],
				]}
			/>
		</g>
	</svg>
);

export const WaveDoodle = () => (
	<svg
		viewBox="0 0 120 104"
		className="h-auto w-24 overflow-visible"
		aria-hidden="true"
	>
		<g className="ob-boil">
			<path
				pathLength={1}
				className="ob-ink is-bold ob-draw"
				style={{ "--d": "0.1s", strokeWidth: 4.2 } as CSSProperties}
				d="M 28 82 C 30 64 34 42 38 22 C 40 14 32 14 31 24 C 29 44 28 66 27 86 C 32 70 38 58 46 58 C 54 58 52 72 52 84"
			/>
			<path
				pathLength={1}
				className="ob-ink is-bold ob-draw"
				style={{ "--d": "0.75s", strokeWidth: 4.2 } as CSSProperties}
				d="M 66 60 C 66 68 65 76 66 84"
			/>
			<path
				pathLength={1}
				className="ob-ink is-bold ob-draw"
				style={{ "--d": "0.95s", strokeWidth: 4.8 } as CSSProperties}
				d="M 66 44 L 66 44.6"
			/>
			<Sparks
				delay={1.1}
				points={[
					[90, 30, 3.4],
					[104, 60, 2.8],
				]}
			/>
		</g>
	</svg>
);
