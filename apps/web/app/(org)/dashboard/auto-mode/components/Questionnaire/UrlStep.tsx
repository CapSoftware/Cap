"use client";

import { Input } from "@cap/ui";
import { faGlobe } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

interface UrlStepProps {
	value: string;
	onChange: (value: string) => void;
}

export function UrlStep({ value, onChange }: UrlStepProps) {
	return (
		<div className="flex flex-col gap-6 w-full">
			<div className="flex flex-col gap-2 text-center">
				<div className="flex items-center justify-center w-12 h-12 mx-auto rounded-xl bg-gradient-to-br from-blue-500/20 to-purple-500/20">
					<FontAwesomeIcon icon={faGlobe} className="w-6 h-6 text-blue-500" />
				</div>
				<h2 className="text-xl font-semibold text-gray-12">
					Target Website URL
				</h2>
				<p className="text-gray-11">
					Enter the URL of the website you want to record. We&apos;ll analyze
					its structure to create better automation.
				</p>
			</div>

			<div className="flex flex-col gap-2">
				<Input
					type="url"
					placeholder="https://example.com"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					className="w-full text-center"
					aria-label="Target website URL"
				/>
				<p className="text-sm text-center text-gray-9">
					Optional - Skip if you don&apos;t have a specific URL
				</p>
			</div>
		</div>
	);
}
