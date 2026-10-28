import { GlassMark, useGlassLogoIds } from "./glass-logo";

export const LogoBadge = ({ className }: { className: string }) => {
	const ids = useGlassLogoIds();

	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			className={className}
			role="img"
			aria-label="Cap"
			fill="none"
			viewBox="0 0 40 40"
			preserveAspectRatio="xMidYMid meet"
			style={{
				aspectRatio: "1 / 1",
			}}
		>
			<GlassMark ids={ids} />
		</svg>
	);
};
