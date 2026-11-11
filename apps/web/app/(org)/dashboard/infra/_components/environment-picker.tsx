"use client";

import clsx from "clsx";
import { useId } from "react";

type Environment = "development" | "production";

const options: { value: Environment; name: string; description: string }[] = [
	{
		value: "development",
		name: "Development",
		description: "Public key works from any origin.",
	},
	{
		value: "production",
		name: "Production",
		description: "Public key only works from allowed domains.",
	},
];

export function EnvironmentPicker({
	value,
	onChange,
}: {
	value: Environment;
	onChange: (value: Environment) => void;
}) {
	const groupId = useId();

	return (
		<fieldset className="flex flex-col gap-2">
			<legend className="mb-2 text-sm font-medium text-gray-12">
				Environment
			</legend>
			<div className="grid gap-2 sm:grid-cols-2">
				{options.map((option) => {
					const selected = value === option.value;
					return (
						<label
							key={option.value}
							className={clsx(
								"flex flex-col gap-0.5 px-3 py-2.5 rounded-xl border transition-colors cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-gray-8",
								selected
									? "border-gray-8 bg-gray-3"
									: "border-gray-4 hover:border-gray-6",
							)}
						>
							<input
								type="radio"
								name={groupId}
								value={option.value}
								checked={selected}
								onChange={() => onChange(option.value)}
								className="sr-only"
							/>
							<span className="text-sm text-gray-12">{option.name}</span>
							<span className="text-xs text-gray-10">{option.description}</span>
						</label>
					);
				})}
			</div>
		</fieldset>
	);
}
