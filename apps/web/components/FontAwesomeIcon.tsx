import type { IconDefinition } from "@fortawesome/free-solid-svg-icons";
import type { CSSProperties } from "react";

// Renders the markup `@fortawesome/react-fontawesome` renders for an icon
// definition, without the icon runtime: importing that package ships
// `@fortawesome/fontawesome-svg-core` (about 24 KB gzipped) and makes it inject
// a 33 KB stylesheet into every page. The one rule of that stylesheet these
// icons use lives in `app/globals.css`. The markup is pinned against the
// package in `__tests__/unit/fontawesome-icon.test.ts`.
export function FontAwesomeIcon({
	icon,
	className,
	style,
}: {
	icon: IconDefinition;
	className?: string;
	style?: CSSProperties;
	"aria-hidden"?: true | "true";
}) {
	const [width, height, , , paths] = icon.icon;

	return (
		<svg
			data-prefix={icon.prefix}
			data-icon={icon.iconName}
			className={`svg-inline--fa fa-${icon.iconName} ${className ?? ""}`}
			role="img"
			viewBox={`0 0 ${width} ${height}`}
			aria-hidden="true"
			style={style}
		>
			{(Array.isArray(paths) ? paths : [paths]).map((path) => (
				<path key={path} fill="currentColor" d={path} />
			))}
		</svg>
	);
}
