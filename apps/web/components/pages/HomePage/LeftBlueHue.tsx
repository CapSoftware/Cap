"use client";

const LeftBlueHue = () => {
	return (
		<svg
			className="absolute top-10 -left-24 z-0 opacity-20 pointer-events-none md:opacity-100"
			width="1276"
			height="690"
			viewBox="0 0 1276 690"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
		>
			<g filter="url(#blue-hue-filter)">
				<ellipse
					cx="592"
					cy="339"
					rx="584"
					ry="251"
					transform="rotate(180 592 339)"
					fill="url(#blue-hue-gradient)"
				/>
			</g>
			<defs>
				<filter
					id="blue-hue-filter"
					x="-92"
					y="-12"
					width="1368"
					height="702"
					filterUnits="userSpaceOnUse"
					colorInterpolationFilters="sRGB"
				>
					<feFlood floodOpacity="0" result="BackgroundImageFix" />
					<feBlend
						mode="normal"
						in="SourceGraphic"
						in2="BackgroundImageFix"
						result="shape"
					/>
					<feGaussianBlur stdDeviation="50" result="blur-effect" />
				</filter>
				<linearGradient
					id="blue-hue-gradient"
					x1="1102.5"
					y1="339"
					x2="157.5"
					y2="375.5"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="#75A3FE" />
					<stop offset="1" stopColor="white" stopOpacity="0" />
				</linearGradient>
			</defs>
		</svg>
	);
};
export default LeftBlueHue;
