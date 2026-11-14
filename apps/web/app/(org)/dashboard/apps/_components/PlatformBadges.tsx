import { Globe, Monitor } from "lucide-react";

const LABELS = {
	web: { label: "Web", Icon: Globe },
	desktop: { label: "Desktop", Icon: Monitor },
} as const;

export function PlatformBadges({
	platforms,
}: {
	platforms: readonly ("web" | "desktop")[];
}) {
	return (
		<div className="flex items-center gap-1">
			{platforms.map((platform) => {
				const { label, Icon } = LABELS[platform];
				return (
					<span
						key={platform}
						className="inline-flex items-center gap-1 rounded-md bg-gray-3 px-1.5 py-0.5 text-[11px] font-medium text-gray-10"
					>
						<Icon className="size-3" aria-hidden />
						{label}
					</span>
				);
			})}
		</div>
	);
}
