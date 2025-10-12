import {
	type AppDefinitionType,
	type AppSelection,
	AppStatusBadge,
} from "@cap/apps/ui";
import { Button, Card } from "@cap/ui";
import clsx from "clsx";
import Link from "next/link";
import { useMemo } from "react";

import { useAppInstallation } from "./useAppInstallation";

type AppCardProps = {
	definition: AppDefinitionType;
	onOpenManage?: (selection: AppSelection) => void;
};

const AppCard = ({
	definition,
	onOpenManage,
}: AppCardProps) => {
	const {
		status,
		providerDisplayName,
		hasInstallationError,
		buttonLabel,
		buttonDisabled,
		buttonSpinner,
		handleAction,
		installationQuery,
	} = useAppInstallation({ definition, onOpenManage });

	const categoryLabel = definition.category.replace(/_/g, " ");
	const contentPreview = useMemo(() => {
		const baseSource = definition.content?.trim() ?? "";
		if (baseSource.length === 0) {
			return definition.description;
		}

		const paragraphs = baseSource
			.split(/\n\s*\n/)
			.map((segment) => segment.trim())
			.filter(Boolean);
		const firstParagraph = paragraphs[0] ?? baseSource;
		return firstParagraph.replace(/^#+\s*/, "");
	}, [definition.content, definition.description]);

	const appInitial = definition.displayName?.[0]?.toUpperCase() ?? "A";

	return (
		<Card
			className={clsx(
				"flex h-full flex-col gap-5 border-gray-3 bg-gray-1 p-5 transition-colors duration-200",
				onOpenManage && "hover:border-gray-4",
			)}
		>
			<div className="flex items-start gap-3">
				<div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl border border-gray-4 bg-white">
					{definition.image ? (
						<img
							src={definition.image}
							alt={`${definition.displayName} logo`}
							className="h-full w-full object-contain p-1.5"
							loading="lazy"
						/>
					) : (
						<span className="text-base font-semibold text-gray-12">
							{appInitial}
						</span>
					)}
				</div>
				<div className="flex flex-1 flex-col gap-2">
					<div className="flex flex-wrap items-center gap-2">
						<h2 className="text-lg font-semibold leading-tight text-gray-12">
							{definition.displayName}
						</h2>
						<AppStatusBadge status={status} />
					</div>
					<p className="text-sm leading-relaxed text-gray-11 line-clamp-4">
						{contentPreview}
					</p>
				</div>
			</div>

			<div className="flex flex-col gap-1 text-sm text-gray-10">
				{installationQuery.isLoading ? (
					<div className="h-4 w-32 animate-pulse rounded bg-gray-5" />
				) : providerDisplayName ? (
					<p>
						Connected as
						<span className="ml-1 font-medium text-gray-12">
							{providerDisplayName}
						</span>
					</p>
				) : (
					<p>Complete setup to start sharing automatically.</p>
				)}
				{hasInstallationError && (
					<p className="text-sm text-red-11">
						We couldn&apos;t load the latest status.
					</p>
				)}
			</div>

			<div className="mt-auto flex flex-col gap-3 pt-1">
				<div className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-gray-9">
					<span>{categoryLabel}</span>
				</div>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<Button variant="outline" size="sm" asChild>
						<Link href={`/dashboard/apps/${definition.slug}`}>More info</Link>
					</Button>
					<Button
						variant="dark"
						size="sm"
						disabled={buttonDisabled}
						spinner={buttonSpinner}
						onClick={handleAction}
					>
						{buttonLabel}
					</Button>
				</div>
			</div>
		</Card>
	);
};

export type { AppCardProps };
export { AppCard };
