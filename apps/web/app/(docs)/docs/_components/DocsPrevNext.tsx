import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import { getAdjacentDocs } from "../docs-config";

interface DocsPrevNextProps {
	currentSlug: string;
}

export function DocsPrevNext({ currentSlug }: DocsPrevNextProps) {
	const { prev, next } = getAdjacentDocs(currentSlug);

	if (!prev && !next) return null;

	return (
		<div className="mt-14 grid grid-cols-1 gap-3 border-t border-gray-3 pt-8 sm:grid-cols-2">
			{prev ? (
				<Link
					href={`/docs/${prev.slug}`}
					className="group flex flex-col gap-1 rounded-xl border border-gray-4 p-4 transition-colors hover:border-gray-6 hover:bg-gray-2"
				>
					<span className="flex items-center gap-1 text-xs text-gray-10">
						<ArrowLeft className="size-3 transition-transform group-hover:-translate-x-0.5" />
						Previous
					</span>
					<span className="text-sm font-medium text-gray-12 transition-colors group-hover:text-blue-11">
						{prev.title}
					</span>
				</Link>
			) : (
				<div className="hidden sm:block" />
			)}
			{next ? (
				<Link
					href={`/docs/${next.slug}`}
					className="group flex flex-col items-end gap-1 rounded-xl border border-gray-4 p-4 text-right transition-colors hover:border-gray-6 hover:bg-gray-2 sm:col-start-2"
				>
					<span className="flex items-center gap-1 text-xs text-gray-10">
						Next
						<ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
					</span>
					<span className="text-sm font-medium text-gray-12 transition-colors group-hover:text-blue-11">
						{next.title}
					</span>
				</Link>
			) : null}
		</div>
	);
}
