"use client";

import { Label } from "@cap/ui";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export function ApiKeyDisplay({
	label,
	value,
	sensitive = false,
}: {
	label: string;
	value: string;
	sensitive?: boolean;
}) {
	const [visible, setVisible] = useState(!sensitive);
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(value);
		setCopied(true);
		toast.success("Copied to clipboard");
		setTimeout(() => setCopied(false), 2000);
	};

	const displayValue = visible
		? value
		: `${value.slice(0, 8)}${"•".repeat(20)}`;

	return (
		<div className="flex flex-col gap-1.5">
			<Label className="text-xs">{label}</Label>
			<div className="flex gap-2 items-center">
				<code className="flex-1 px-3 py-2 text-xs rounded-lg bg-gray-3 text-gray-11 font-mono truncate">
					{displayValue}
				</code>
				{sensitive && (
					<button
						type="button"
						onClick={() => setVisible(!visible)}
						className="p-1.5 rounded-md hover:bg-gray-3 text-gray-10 transition-colors"
					>
						{visible ? <EyeOff size={14} /> : <Eye size={14} />}
					</button>
				)}
				<button
					type="button"
					onClick={handleCopy}
					className="p-1.5 rounded-md hover:bg-gray-3 text-gray-10 transition-colors"
				>
					{copied ? (
						<Check size={14} className="text-green-400" />
					) : (
						<Copy size={14} />
					)}
				</button>
			</div>
		</div>
	);
}
