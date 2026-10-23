import { getBreadcrumbs } from "../docs-config";

interface DocsBreadcrumbsProps {
	currentSlug: string;
	pageTitle?: string;
}

export function DocsBreadcrumbs({
	currentSlug,
	pageTitle,
}: DocsBreadcrumbsProps) {
	const breadcrumbs = getBreadcrumbs(currentSlug);
	const group =
		breadcrumbs.length > 1 ? breadcrumbs[breadcrumbs.length - 2] : null;

	if (!group) return null;
	if (pageTitle && group.title.toLowerCase() === pageTitle.toLowerCase()) {
		return null;
	}

	return (
		<p className="mb-2.5 text-[13px] font-medium leading-5 text-blue-11">
			{group.title}
		</p>
	);
}
