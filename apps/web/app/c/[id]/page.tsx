import { buttonVariants, Logo } from "@cap/ui";
import {
	faArrowLeft,
	faArrowUpRightFromSquare,
	faFolder,
	faLock,
	faVideo,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { PublicCapCard } from "@/components/PublicCapCard";
import {
	GRID_COLUMN_CLASS,
	sanitizeCtaUrl,
} from "@/lib/public-collection-settings";
import {
	getPublicCollectionMetadata,
	getPublicCollectionPageData,
	type PublicCollection,
	type PublicCollectionFolder,
} from "@/lib/public-collections";
import {
	getPublicCollectionHref,
	parsePublicCollectionPage,
} from "@/lib/public-collections-policy";
import type { SharePageBranding } from "@/lib/share-branding";
import { CapPagination } from "../../(org)/dashboard/caps/components/CapPagination";
import { CollectionCopyLinkButton } from "./CollectionCopyLinkButton";
import { CollectionPasswordOverlay } from "./CollectionPasswordOverlay";

export async function generateMetadata(
	props: PageProps<"/c/[id]">,
): Promise<Metadata> {
	const params = await props.params;
	const collection = await getPublicCollectionMetadata(params.id);

	if (!collection) notFound();

	const title = collection.publicPage.title.trim() || collection.name;
	const description =
		collection.publicPage.subtitle.trim() ||
		collection.description?.trim() ||
		`View public videos in ${title} on Cap.`;

	return {
		title: `${title} | Cap Collection`,
		description,
		robots: "noindex, nofollow",
	};
}

function resolveBranding(
	collection: PublicCollection,
): SharePageBranding | null {
	const { logoMode } = collection.publicPage;

	if (logoMode === "none") return null;

	if (logoMode === "custom" && collection.collectionLogoUrl) {
		return {
			type: "custom",
			imageUrl: collection.collectionLogoUrl,
			name: collection.organizationName,
		};
	}

	if (logoMode === "organization" && collection.organizationIconUrl) {
		return {
			type: "custom",
			imageUrl: collection.organizationIconUrl,
			name: collection.organizationName,
		};
	}

	return { type: "cap" };
}

function BrandingMark({
	branding,
	className,
}: {
	branding: SharePageBranding;
	className?: string;
}) {
	if (branding.type === "custom") {
		return (
			// biome-ignore lint/performance/noImgElement: arbitrary org-uploaded icon
			<img
				src={branding.imageUrl}
				alt={branding.name}
				className={className ?? "h-7 w-auto max-w-[160px] object-contain"}
			/>
		);
	}
	return <Logo className={className ?? "h-7 w-auto"} />;
}

export default async function PublicCollectionPage(
	props: PageProps<"/c/[id]">,
) {
	const params = await props.params;
	const searchParams = await props.searchParams;
	const page = parsePublicCollectionPage(searchParams.page);
	const data = await getPublicCollectionPageData(params.id, page);

	if (!data) notFound();

	const branding = resolveBranding(data.collection);

	if (data.access.state === "email_restriction_login_required") {
		return (
			<CollectionAccessView
				branding={branding}
				title="This collection requires sign-in"
				description={
					<>
						The owner has restricted access. Please{" "}
						<Link href="/login" className="text-gray-12 underline">
							sign in
						</Link>{" "}
						with an authorized email address to view.
					</>
				}
			/>
		);
	}

	if (data.access.state === "email_restriction_denied") {
		return (
			<CollectionAccessView
				branding={branding}
				title="Access restricted"
				description="Your email address does not meet the requirements set by this collection owner."
			/>
		);
	}

	const isPasswordRequired = data.access.state === "password_required";
	const showCopyLink =
		!isPasswordRequired && !data.collection.publicPage.hideCopyLink;
	const showHeader = Boolean(branding) || showCopyLink;

	return (
		<div className="flex flex-col min-h-screen bg-gray-2 text-gray-12">
			<CollectionPasswordOverlay
				collectionId={data.collection.id}
				collectionName={data.collection.name}
				organizationName={data.collection.organizationName}
				branding={branding}
				isOpen={isPasswordRequired}
			/>
			{data.viewerIsSignedIn && (
				<div className="border-b border-gray-4 bg-gray-1">
					<div className="flex items-center px-4 mx-auto max-w-7xl h-11 sm:px-6 lg:px-8">
						<Link
							href="/dashboard/caps"
							className="inline-flex gap-1.5 items-center text-[13px] transition-colors text-gray-10 hover:text-gray-12"
						>
							<FontAwesomeIcon icon={faArrowLeft} className="size-3" />
							Back to dashboard
						</Link>
					</div>
				</div>
			)}
			{showHeader && (
				<header className="sticky top-0 z-30 border-b backdrop-blur-md border-gray-4 bg-gray-1/85">
					<div className="flex justify-between items-center px-4 mx-auto max-w-7xl h-16 sm:px-6 lg:px-8">
						{branding ? (
							branding.type === "cap" ? (
								<Link href="/?ref=collection" aria-label="Cap home">
									<BrandingMark branding={branding} />
								</Link>
							) : (
								<BrandingMark branding={branding} />
							)
						) : (
							<span />
						)}
						{showCopyLink && <CollectionCopyLinkButton />}
					</div>
				</header>
			)}

			<main className="flex-1 px-4 py-10 mx-auto w-full max-w-7xl sm:px-6 lg:px-8 sm:py-12">
				<CollectionHero
					collection={data.collection}
					videoCount={data.totalCount}
					folderCount={data.folders.length}
				/>

				{isPasswordRequired ? (
					<CollectionStateCard
						icon={faLock}
						title="Password required"
						description="Enter the collection password to view its public videos."
					/>
				) : (
					<CollectionContent data={data} />
				)}
			</main>

			<CollectionFooter
				showPoweredBy={data.collection.publicPage.logoMode !== "none"}
			/>
		</div>
	);
}

function CollectionHero({
	collection,
	videoCount,
	folderCount,
}: {
	collection: PublicCollection;
	videoCount: number;
	folderCount: number;
}) {
	const { publicPage } = collection;

	const title = publicPage.title.trim() || collection.name;
	const subtitle =
		publicPage.subtitle.trim() || collection.description?.trim() || "";
	const ctaLabel = publicPage.ctaLabel.trim();
	const ctaUrl = sanitizeCtaUrl(publicPage.ctaUrl);

	const metaParts = [collection.organizationName];
	if (videoCount > 0)
		metaParts.push(`${videoCount} ${videoCount === 1 ? "video" : "videos"}`);
	if (folderCount > 0)
		metaParts.push(
			`${folderCount} ${folderCount === 1 ? "folder" : "folders"}`,
		);

	return (
		<section className="pb-8 mb-10 border-b border-gray-4">
			<div className="max-w-2xl">
				{!publicPage.hideTitle && (
					<h1 className="text-3xl font-semibold tracking-tight text-gray-12 sm:text-4xl">
						{title}
					</h1>
				)}
				{subtitle && (
					<p className="mt-3 text-base leading-7 text-gray-11">{subtitle}</p>
				)}
				<p className="mt-3 text-sm text-gray-10">{metaParts.join(" · ")}</p>
				{ctaLabel && ctaUrl && (
					<a
						href={ctaUrl}
						target="_blank"
						rel="noreferrer"
						className={buttonVariants({
							variant: "blue",
							size: "sm",
							className: "mt-6 w-fit",
						})}
					>
						{ctaLabel}
						<FontAwesomeIcon
							icon={faArrowUpRightFromSquare}
							className="size-3"
						/>
					</a>
				)}
			</div>
		</section>
	);
}

function CollectionContent({
	data,
}: {
	data: NonNullable<Awaited<ReturnType<typeof getPublicCollectionPageData>>>;
}) {
	const renderedAt = Date.now();
	const hasContent = data.folders.length > 0 || data.videos.length > 0;
	const { layout, gridColumns } = data.collection.publicPage;
	const containerClass =
		layout === "list"
			? "flex flex-col gap-2"
			: `grid grid-cols-1 gap-4 sm:grid-cols-2 ${GRID_COLUMN_CLASS[gridColumns]}`;

	return (
		<div className="space-y-10">
			{data.folders.length > 0 && (
				<section>
					<SectionHeading title="Folders" count={data.folders.length} />
					<div className={containerClass}>
						{data.folders.map((folder) => (
							<PublicFolderCard
								key={folder.id}
								folder={folder}
								layout={layout}
							/>
						))}
					</div>
				</section>
			)}

			{data.videos.length > 0 && (
				<section>
					<SectionHeading title="Videos" count={data.totalCount} />
					<div className={containerClass}>
						{data.videos.map((video) => (
							<PublicCapCard
								key={video.id}
								cap={video}
								now={renderedAt}
								layout={layout}
							/>
						))}
					</div>
				</section>
			)}

			{!hasContent && (
				<CollectionStateCard
					icon={faVideo}
					title="No public videos yet"
					description="This collection does not have any public videos available."
				/>
			)}

			{data.totalPages > 1 && (
				<div className="flex justify-center pt-2">
					<CapPagination
						currentPage={data.currentPage}
						totalPages={data.totalPages}
						hrefForPage={(targetPage) =>
							getPublicCollectionHref(data.collection.id, targetPage)
						}
					/>
				</div>
			)}
		</div>
	);
}

function SectionHeading({ title, count }: { title: string; count: number }) {
	return (
		<div className="flex gap-2.5 items-baseline mb-4">
			<h2 className="text-lg font-medium text-gray-12">{title}</h2>
			<span className="text-sm tabular-nums text-gray-9">{count}</span>
		</div>
	);
}

function CollectionStateCard({
	icon,
	title,
	description,
}: {
	icon: typeof faVideo;
	title: string;
	description: string;
}) {
	return (
		<section className="flex justify-center items-center p-8 min-h-[340px] text-center rounded-2xl border border-dashed border-gray-4 bg-gray-1">
			<div className="max-w-sm">
				<div className="flex justify-center items-center mx-auto mb-4 rounded-full size-12 bg-gray-3 text-gray-10">
					<FontAwesomeIcon icon={icon} className="size-5" />
				</div>
				<h2 className="text-lg font-medium text-gray-12">{title}</h2>
				<p className="mt-2 text-sm leading-6 text-gray-10">{description}</p>
			</div>
		</section>
	);
}

function PublicFolderCard({
	folder,
	layout,
}: {
	folder: PublicCollectionFolder;
	layout: "grid" | "list";
}) {
	const meta = `${folder.videoCount} ${
		folder.videoCount === 1 ? "video" : "videos"
	}`;

	if (layout === "list") {
		return (
			<Link
				href={`/c/${folder.id}`}
				className="flex gap-3 items-center p-3 rounded-xl border transition-colors border-gray-4 bg-gray-1 hover:border-gray-6"
			>
				<div className="flex shrink-0 justify-center items-center rounded-lg size-9 bg-gray-3 text-gray-10">
					<FontAwesomeIcon icon={faFolder} className="size-4" />
				</div>
				<div className="min-w-0">
					<h3 className="text-sm font-medium truncate text-gray-12">
						{folder.name}
					</h3>
					<p className="text-xs text-gray-10">{meta}</p>
				</div>
			</Link>
		);
	}

	return (
		<Link
			href={`/c/${folder.id}`}
			className="flex gap-3 items-start p-4 rounded-xl border transition-colors min-h-28 border-gray-4 bg-gray-1 hover:border-gray-6"
		>
			<div className="flex shrink-0 justify-center items-center rounded-lg size-10 bg-gray-3 text-gray-10">
				<FontAwesomeIcon icon={faFolder} className="size-4" />
			</div>
			<div className="min-w-0">
				<h3 className="text-base font-medium leading-6 truncate text-gray-12">
					{folder.name}
				</h3>
				<p className="mt-1 text-sm text-gray-10">{meta}</p>
			</div>
		</Link>
	);
}

function CollectionFooter({ showPoweredBy }: { showPoweredBy: boolean }) {
	if (!showPoweredBy) return null;

	return (
		<footer className="mt-16 border-t border-gray-4">
			<div className="flex justify-center items-center px-4 mx-auto max-w-7xl h-16 sm:px-6 lg:px-8">
				<a
					href="https://cap.so/?ref=collection"
					target="_blank"
					rel="noreferrer"
					className="inline-flex gap-1.5 items-center text-xs transition-colors text-gray-9 hover:text-gray-11"
				>
					Powered by
					<Logo className="w-auto h-3.5" />
				</a>
			</div>
		</footer>
	);
}

function CollectionAccessView({
	branding,
	title,
	description,
}: {
	branding: SharePageBranding | null;
	title: string;
	description: ReactNode;
}) {
	return (
		<div className="flex flex-col justify-center items-center p-4 min-h-screen text-center bg-gray-2 text-gray-12">
			{branding ? (
				<BrandingMark
					branding={branding}
					className="mb-6 h-12 w-auto max-w-[200px] object-contain"
				/>
			) : (
				<Logo className="mb-6 size-24" />
			)}
			<h1 className="mb-2 text-2xl font-semibold">{title}</h1>
			<p className="max-w-md text-gray-10">{description}</p>
		</div>
	);
}
