import clsx from "clsx";

export function EnvironmentBadge({
	environment,
	size = "sm",
}: {
	environment: string;
	size?: "sm" | "xs";
}) {
	const isProduction = environment === "production";
	return (
		<span
			className={clsx(
				"inline-flex items-center rounded-md font-medium",
				size === "sm" ? "px-1.5 py-0.5 text-xs" : "px-1 py-px text-[10px]",
				isProduction
					? "bg-blue-400/15 text-blue-11"
					: "bg-yellow-400/15 text-yellow-11",
			)}
		>
			{isProduction ? "prod" : "dev"}
		</span>
	);
}
