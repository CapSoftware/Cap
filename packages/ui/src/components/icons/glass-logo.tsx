import { useId } from "react";

export const WORDMARK_PATH =
	"M58.416 30.448c-5.404 0-9.212-3.864-9.212-10.36 0-6.384 3.668-10.416 9.268-10.416 5.068 0 7.784 2.66 8.624 7.168l-3.808.196c-.476-2.604-2.072-4.2-4.816-4.2-3.388 0-5.488 2.828-5.488 7.252 0 4.48 2.156 7.196 5.46 7.196 2.94 0 4.508-1.708 4.956-4.564l3.808.196c-.784 4.676-3.752 7.532-8.792 7.532zM73.796 30.336c-3.137 0-5.209-1.484-5.209-4.088 0-2.576 1.596-3.948 4.872-4.592l4.956-.98c0-2.1-.98-3.192-2.856-3.192-1.764 0-2.716.812-3.052 2.324l-3.668-.168c.588-3.136 2.996-4.928 6.72-4.928 4.256 0 6.44 2.24 6.44 6.216v5.432c0 .812.28 1.036.84 1.036h.476V30c-.224.056-.812.112-1.288.112-1.624 0-2.828-.588-3.136-2.436-.728 1.596-2.632 2.66-5.096 2.66zm.727-2.604c2.38 0 3.892-1.512 3.892-3.78v-.84l-3.864.784c-1.596.308-2.24.98-2.24 2.016 0 1.176.784 1.82 2.212 1.82zM84.877 34.2V15.048h3.444l.056 2.212c.868-1.652 2.52-2.548 4.48-2.548 4.256 0 6.356 3.5 6.356 7.812s-2.128 7.812-6.384 7.812c-1.904 0-3.556-.924-4.368-2.38V34.2h-3.584zm7.112-6.776c2.184 0 3.5-1.82 3.5-4.9s-1.316-4.9-3.5-4.9-3.528 1.652-3.528 4.9 1.316 4.9 3.528 4.9z";

const WORDMARK_TRANSFORM = "translate(-3.764 -1.517) scale(1.05)";

export type GlassLogoIds = {
	id: (name: string) => string;
	url: (name: string) => string;
};

// Gradient, filter and mask ids must be unique per rendered logo, or a second
// copy on the page resolves url(#...) against the first one.
export const useGlassLogoIds = (): GlassLogoIds => {
	const prefix = `cap-logo-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
	return {
		id: (name) => `${prefix}-${name}`,
		url: (name) => `url(#${prefix}-${name})`,
	};
};

const RingLift = ({
	id,
	blur,
	dy,
	alpha,
}: {
	id: string;
	blur: number;
	dy: number;
	alpha: number;
}) => (
	<filter
		id={id}
		x="-30%"
		y="-30%"
		width="160%"
		height="160%"
		colorInterpolationFilters="sRGB"
	>
		<feGaussianBlur in="SourceAlpha" stdDeviation={blur} />
		<feOffset dy={dy} />
		<feColorMatrix
			values={`0 0 0 0 0.1  0 0 0 0 0.27  0 0 0 0 0.75  0 0 0 ${alpha} 0`}
		/>
		<feMerge>
			<feMergeNode />
			<feMergeNode in="SourceGraphic" />
		</feMerge>
	</filter>
);

const RingRim = ({
	id,
	inset,
	top,
	bottom,
}: {
	id: string;
	inset: number;
	top: number;
	bottom: number;
}) => (
	<linearGradient
		id={id}
		x1={inset}
		y1={inset}
		x2={40 - inset}
		y2={40 - inset}
		gradientUnits="userSpaceOnUse"
	>
		<stop offset="0" stopColor="#fff" stopOpacity={top} />
		<stop offset="0.38" stopColor="#fff" stopOpacity="0" />
		<stop offset="0.72" stopColor="#fff" stopOpacity="0" />
		<stop offset="1" stopColor="#fff" stopOpacity={bottom} />
	</linearGradient>
);

export const GlassMark = ({ ids: { id, url } }: { ids: GlassLogoIds }) => (
	<>
		<defs>
			<clipPath id={id("clip")}>
				<rect x="0.25" y="0.25" width="39.5" height="39.5" rx="7.75" />
			</clipPath>
			<radialGradient
				id={id("dome")}
				cx="20"
				cy="6"
				r="34"
				gradientUnits="userSpaceOnUse"
			>
				<stop offset="0" stopColor="#fff" stopOpacity="0" />
				<stop offset="0.62" stopColor="#fff" stopOpacity="0" />
				<stop offset="1" stopColor="#C4D6FA" stopOpacity="0.14" />
			</radialGradient>
			<linearGradient
				id={id("top")}
				x1="20"
				y1="0"
				x2="20"
				y2="9"
				gradientUnits="userSpaceOnUse"
			>
				<stop offset="0" stopColor="#fff" />
				<stop offset="1" stopColor="#fff" stopOpacity="0" />
			</linearGradient>
			<filter
				id={id("top-blur")}
				x="-80%"
				y="-80%"
				width="260%"
				height="260%"
				colorInterpolationFilters="sRGB"
			>
				<feGaussianBlur stdDeviation="0.8" />
			</filter>
			<linearGradient
				id={id("rim")}
				x1="0"
				y1="0"
				x2="40"
				y2="40"
				gradientUnits="userSpaceOnUse"
			>
				<stop offset="0" stopColor="#fff" stopOpacity="0.58" />
				<stop offset="0.32" stopColor="#fff" stopOpacity="0.087" />
				<stop offset="0.68" stopColor="#fff" stopOpacity="0.02" />
				<stop offset="1" stopColor="#fff" stopOpacity="0.52" />
			</linearGradient>
			<filter id={id("glow-blur")} x="-20%" y="-20%" width="140%" height="140%">
				<feGaussianBlur stdDeviation="1" />
			</filter>
			<filter
				id={id("glint-blur")}
				x="-50%"
				y="-50%"
				width="200%"
				height="200%"
			>
				<feGaussianBlur stdDeviation="0.35" />
			</filter>
			<RingRim id={id("ring-rim-1")} inset={8.48} top={0.9} bottom={0.4} />
			<RingRim id={id("ring-rim-2")} inset={10.64} top={0.9} bottom={0.3} />
			<RingRim id={id("ring-rim-3")} inset={12.8} top={0.6} bottom={0.2} />
			<RingLift id={id("ring-lift-1")} blur={0.8} dy={0.35} alpha={0.24} />
			<RingLift id={id("ring-lift-2")} blur={0.7} dy={0.3} alpha={0.26} />
			<RingLift id={id("ring-lift-3")} blur={0.7} dy={0.3} alpha={0.28} />
		</defs>
		<rect x="0.25" y="0.25" width="39.5" height="39.5" rx="7.75" fill="#fff" />
		<g clipPath={url("clip")}>
			<rect width="40" height="40" fill={url("dome")} />
			<rect
				x="3"
				y="1.2"
				width="34"
				height="5"
				rx="2.5"
				fill={url("top")}
				opacity="0.9"
				filter={url("top-blur")}
			/>
			<rect
				x="0.25"
				y="0.25"
				width="39.5"
				height="39.5"
				rx="7.75"
				stroke="#4785FF"
				strokeOpacity="0.24"
				strokeWidth="2.8"
				filter={url("glow-blur")}
			/>
		</g>
		<rect
			x="1.225"
			y="1.225"
			width="37.55"
			height="37.55"
			rx="6.775"
			stroke={url("rim")}
			strokeWidth="1.15"
		/>
		<g
			filter={url("glint-blur")}
			stroke="#fff"
			strokeLinecap="round"
			strokeWidth="0.9"
			opacity="0.21"
		>
			<path d="M1.25 14V8.6A6.75 6.75 0 0 1 8 1.25H15" />
			<path d="M38.75 26V31.4A6.75 6.75 0 0 1 32 38.75H25" opacity="0.7" />
		</g>
		<rect
			x="0.35"
			y="0.35"
			width="39.3"
			height="39.3"
			rx="7.65"
			stroke="#4785FF"
			strokeOpacity="0.16"
			strokeWidth="0.7"
		/>
		<circle cx="20" cy="20" r="16" fill="#4785FF" filter={url("ring-lift-1")} />
		<circle
			cx="20"
			cy="20"
			r="15.7"
			stroke={url("ring-rim-1")}
			strokeWidth="0.6"
		/>
		<circle cx="20" cy="20" r="13" fill="#ADC9FF" filter={url("ring-lift-2")} />
		<circle
			cx="20"
			cy="20"
			r="12.75"
			stroke={url("ring-rim-2")}
			strokeWidth="0.5"
		/>
		<circle cx="20" cy="20" r="10" fill="#fff" filter={url("ring-lift-3")} />
		<circle
			cx="20"
			cy="20"
			r="9.75"
			stroke={url("ring-rim-3")}
			strokeWidth="0.5"
		/>
	</>
);

export const GlassWordmark = ({
	ids: { id, url },
	white,
}: {
	ids: GlassLogoIds;
	white?: boolean;
}) => {
	const flat = (
		<path
			className={white ? undefined : "fill-gray-12"}
			fill="#F5F7FA"
			d={WORDMARK_PATH}
		/>
	);

	return (
		<g transform={WORDMARK_TRANSFORM}>
			{white ? (
				flat
			) : (
				<>
					<defs>
						<linearGradient
							id={id("ink")}
							x1="0"
							y1="9"
							x2="0"
							y2="35"
							gradientUnits="userSpaceOnUse"
						>
							<stop offset="0" stopColor="#2A3243" />
							<stop offset="0.55" stopColor="#12161F" />
							<stop offset="1" stopColor="#05070B" />
						</linearGradient>
						<filter
							id={id("ink-lift")}
							x="-10%"
							y="-30%"
							width="120%"
							height="160%"
							colorInterpolationFilters="sRGB"
						>
							<feGaussianBlur in="SourceAlpha" stdDeviation="0.55" />
							<feOffset dy="0.6" />
							<feColorMatrix values="0 0 0 0 0.1  0 0 0 0 0.22  0 0 0 0 0.6  0 0 0 0.2 0" />
							<feMerge>
								<feMergeNode />
								<feMergeNode in="SourceGraphic" />
							</feMerge>
						</filter>
						<mask
							id={id("shine-mask")}
							maskUnits="userSpaceOnUse"
							x="40"
							y="0"
							width="80"
							height="40"
						>
							<path fill="#fff" d={WORDMARK_PATH} />
							<path
								fill="#000"
								stroke="#000"
								strokeWidth="0.22"
								strokeLinejoin="round"
								transform="translate(0 0.3)"
								d={WORDMARK_PATH}
							/>
						</mask>
						<filter
							id={id("shine-blur")}
							x="-5%"
							y="-5%"
							width="110%"
							height="110%"
						>
							<feGaussianBlur stdDeviation="0.12" />
						</filter>
					</defs>
					<g className="[.dark_&]:hidden">
						<path
							fill={url("ink")}
							filter={url("ink-lift")}
							d={WORDMARK_PATH}
						/>
						<g filter={url("shine-blur")}>
							<rect
								x="40"
								y="0"
								width="80"
								height="40"
								fill="#fff"
								opacity="0.45"
								mask={url("shine-mask")}
							/>
						</g>
					</g>
					<g className="hidden [.dark_&]:inline">{flat}</g>
				</>
			)}
		</g>
	);
};
