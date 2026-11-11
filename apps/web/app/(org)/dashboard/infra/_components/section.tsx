import clsx from "clsx";

export function Section({
	title,
	description,
	action,
	children,
	className,
}: {
	title: string;
	description?: React.ReactNode;
	action?: React.ReactNode;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<section className={clsx("flex flex-col gap-3 min-w-0", className)}>
			<div className="flex flex-wrap gap-x-4 gap-y-2 justify-between items-end">
				<div className="flex flex-col gap-1 min-w-0">
					<h2 className="text-base font-medium text-gray-12">{title}</h2>
					{description && <p className="text-sm text-gray-10">{description}</p>}
				</div>
				{action}
			</div>
			{children}
		</section>
	);
}

export function Panel({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={clsx(
				"rounded-2xl border bg-gray-1 border-gray-3 min-w-0",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function Metric({
	label,
	value,
	hint,
	className,
}: {
	label: string;
	value: React.ReactNode;
	hint?: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={clsx("flex flex-col gap-1 min-w-0", className)}>
			<span className="text-sm text-gray-10">{label}</span>
			<span className="text-xl font-medium tabular-nums text-gray-12">
				{value}
			</span>
			{hint && <span className="text-xs text-gray-10">{hint}</span>}
		</div>
	);
}
