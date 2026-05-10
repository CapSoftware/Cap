import type { CSSProperties } from "react";
import { LogoBadge } from "./LogoBadge";

export const Logo = ({
	className,
	showVersion,
	showBeta,
	white,
	style,
}: {
	className?: string;
	showVersion?: boolean;
	showBeta?: boolean;
	white?: boolean;
	hideLogoName?: boolean;
	style?: CSSProperties;
	viewBoxDimensions?: `${string} ${string} ${string} ${string}`;
}) => {
	return (
		<div className="flex items-center">
			<LogoBadge className={className} style={style} />
			{showVersion && (
				<span
					className={`text-[10px] font-medium ${
						white ? "text-white" : "text-gray-1"
					}`}
				>
					v{process.env.appVersion}
				</span>
			)}
			{showBeta && (
				<span
					className={`text-[10px] font-medium min-w-[52px] ${
						white ? "text-white" : "text-gray-1"
					}`}
				>
					Beta v{process.env.appVersion}
				</span>
			)}
		</div>
	);
};
