import { CopyButton } from "./copy-button";

export function CodeBlock({ code, label }: { code: string; label: string }) {
	return (
		<div className="relative rounded-xl border bg-gray-2 border-gray-4">
			<pre className="overflow-x-auto py-3 pr-12 pl-4 font-mono text-xs leading-5 text-gray-12">
				<code>{code}</code>
			</pre>
			<CopyButton
				value={code}
				label={`Copy ${label}`}
				className="absolute top-2 right-2"
			/>
		</div>
	);
}
