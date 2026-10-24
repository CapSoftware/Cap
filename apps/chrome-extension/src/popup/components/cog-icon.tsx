import clsx from "clsx";
import type { SVGProps } from "react";

interface CogIconProps extends SVGProps<SVGSVGElement> {
	size?: number;
}

const CogIcon = ({ className, size = 28, ...props }: CogIconProps) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
		className={clsx(
			"transition-transform duration-700 [transition-timing-function:cubic-bezier(0.34,1.2,0.64,1)] group-hover:rotate-180",
			className,
		)}
		{...props}
	>
		<title>Settings</title>
		<path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z" />
		<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
		<path d="M12 2v2" />
		<path d="M12 22v-2" />
		<path d="m17 20.66-1-1.73" />
		<path d="M11 10.27 7 3.34" />
		<path d="m20.66 17-1.73-1" />
		<path d="m3.34 7 1.73 1" />
		<path d="M14 12h8" />
		<path d="M2 12h2" />
		<path d="m20.66 7-1.73 1" />
		<path d="m3.34 17 1.73-1" />
		<path d="m17 3.34-1 1.73" />
		<path d="m11 13.73-4 6.93" />
	</svg>
);

export default CogIcon;
