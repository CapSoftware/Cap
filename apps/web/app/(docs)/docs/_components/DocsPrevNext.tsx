import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { getAdjacentDocs } from "../docs-config";

interface DocsPrevNextProps {
	currentSlug: string;
}

export function DocsPrevNext({ currentSlug }: DocsPrevNextProps) {
	const { prev, next } = getAdjacentDocs(currentSlug);

	if (!prev && !next) return null;

	return (
		<div className="flex items-stretch justify-between gap-4 mt-12 pt-6 border-t border-gray-200">
			{prev ? (
				<Link
					href={`/docs/${prev.slug}`}
					className="group flex items-center gap-3 flex-1 px-4 py-3 rounded-lg border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors"
				>
					<ChevronLeft className="w-4 h-4 text-gray-400 group-hover:text-gray-600 transition-colors shrink-0" />
					<div className="flex flex-col">
						<span className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">
							Previous
						</span>
						<span className="text-sm font-medium text-gray-700 group-hover:text-gray-900 transition-colors">
							{prev.title}
						</span>
					</div>
				</Link>
			) : (
				<div className="flex-1" />
			)}
			{next ? (
				<Link
					href={`/docs/${next.slug}`}
					className="group flex items-center justify-end gap-3 flex-1 px-4 py-3 rounded-lg border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors text-right"
				>
					<div className="flex flex-col items-end">
						<span className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">
							Next
						</span>
						<span className="text-sm font-medium text-gray-700 group-hover:text-gray-900 transition-colors">
							{next.title}
						</span>
					</div>
					<ChevronRight className="w-4 h-4 text-gray-400 group-hover:text-gray-600 transition-colors shrink-0" />
				</Link>
			) : (
				<div className="flex-1" />
			)}
		</div>
	);
}
