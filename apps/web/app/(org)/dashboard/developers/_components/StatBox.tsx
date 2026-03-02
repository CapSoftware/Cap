"use client";

export function StatBox({
	label,
	value,
	subtext,
}: {
	label: string;
	value: string | number;
	subtext?: string;
}) {
	return (
		<div className="flex flex-col gap-1 p-4 rounded-xl border border-gray-3 bg-gray-2">
			<span className="text-xs font-medium text-gray-10">{label}</span>
			<span className="text-xl font-semibold text-gray-12 tabular-nums">
				{value}
			</span>
			{subtext && <span className="text-xs text-gray-9">{subtext}</span>}
		</div>
	);
}
