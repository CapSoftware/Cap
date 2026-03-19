import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { getBreadcrumbs } from "../docs-config";

interface DocsBreadcrumbsProps {
	currentSlug: string;
}

export function DocsBreadcrumbs({ currentSlug }: DocsBreadcrumbsProps) {
	const breadcrumbs = getBreadcrumbs(currentSlug);

	return (
		<nav
			className="flex items-center gap-1 text-sm mb-6"
			aria-label="Breadcrumb"
		>
			{breadcrumbs.map((crumb, index) => {
				const isLast = index === breadcrumbs.length - 1;

				return (
					<span
						key={crumb.slug + crumb.title}
						className="flex items-center gap-1"
					>
						{index > 0 && (
							<ChevronRight className="w-3.5 h-3.5 text-gray-300 shrink-0" />
						)}
						{isLast ? (
							<span className="text-gray-700 font-medium">{crumb.title}</span>
						) : (
							<Link
								href={crumb.slug ? `/docs/${crumb.slug}` : "/docs"}
								className="text-gray-400 hover:text-gray-600 transition-colors"
							>
								{crumb.title}
							</Link>
						)}
					</span>
				);
			})}
		</nav>
	);
}
