import { db } from "@cap/database";
import { folders, s3Buckets, videos } from "@cap/database/schema";
import { Logo } from "@cap/ui";
import { S3Buckets } from "@cap/web-backend";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { verifyFolderShareSlug } from "@/lib/folder-share";
import { runPromise } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
	params: Promise<{ slug: string }>;
}): Promise<Metadata> {
	const { slug } = await props.params;
	const folderId = verifyFolderShareSlug(slug);
	if (!folderId) return { title: "Cap" };
	const [folder] = await db()
		.select({ name: folders.name, publicShared: folders.publicShared })
		.from(folders)
		.where(eq(folders.id, folderId));
	if (!folder || !folder.publicShared) return { title: "Cap" };
	return {
		title: `${folder.name} | Cap`,
		description: `Shared folder: ${folder.name}`,
		robots: "noindex, nofollow",
	};
}

const colorTints: Record<string, string> = {
	normal: "#9ca3af",
	blue: "#3b82f6",
	red: "#ef4444",
	yellow: "#eab308",
};

const formatDuration = (s: number | null) => {
	if (s == null || Number.isNaN(s)) return "";
	const m = Math.floor(s / 60);
	const sec = Math.floor(s % 60);
	return `${m}:${sec.toString().padStart(2, "0")}`;
};

async function resolveThumbnailUrl(
	videoId: string,
	ownerId: string,
	bucketId: string | null,
): Promise<string | null> {
	try {
		const [bucket] = await S3Buckets.getBucketAccess(
			Option.fromNullable(bucketId),
		).pipe(runPromise);
		const thumbnailKey = `${ownerId}/${videoId}/screenshot/screen-capture.jpg`;
		const url = await bucket
			.getSignedObjectUrl(thumbnailKey)
			.pipe(runPromise);
		return url;
	} catch {
		return null;
	}
}

export default async function SharedFolderPage(props: {
	params: Promise<{ slug: string }>;
}) {
	const { slug } = await props.params;
	const folderId = verifyFolderShareSlug(slug);
	if (!folderId) return notFound();

	const [folder] = await db()
		.select({
			id: folders.id,
			name: folders.name,
			color: folders.color,
			publicShared: folders.publicShared,
		})
		.from(folders)
		.where(eq(folders.id, folderId));

	if (!folder || !folder.publicShared) return notFound();

	const folderVideos = await db()
		.select({
			id: videos.id,
			name: videos.name,
			createdAt: videos.createdAt,
			duration: videos.duration,
			width: videos.width,
			height: videos.height,
			ownerId: videos.ownerId,
			bucketId: videos.bucket,
		})
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.where(eq(videos.folderId, folderId));

	const videosWithThumbs = await Promise.all(
		folderVideos.map(async (v) => ({
			...v,
			thumbnailUrl: await resolveThumbnailUrl(v.id, v.ownerId, v.bucketId),
		})),
	);

	return (
		<div className="min-h-screen bg-gray-1">
			<header className="border-b border-gray-3 bg-gray-2">
				<div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
					<Link href="/" className="flex items-center gap-2">
						<Logo className="h-7 w-auto" />
					</Link>
					<span className="text-xs text-gray-10">Powered by Cap</span>
				</div>
			</header>
			<main className="mx-auto max-w-6xl px-6 py-10">
				<div className="flex items-center gap-3 mb-2">
					<div
						className="w-4 h-4 rounded-sm shrink-0"
						style={{ backgroundColor: colorTints[folder.color] ?? "#9ca3af" }}
					/>
					<h1 className="text-2xl font-semibold text-gray-12">{folder.name}</h1>
				</div>
				<p className="text-sm text-gray-10 mb-8">
					{folderVideos.length}{" "}
					{folderVideos.length === 1 ? "video" : "videos"}
				</p>

				{folderVideos.length === 0 ? (
					<div className="rounded-xl border border-gray-3 bg-gray-2 p-10 text-center text-gray-10">
						No videos in this folder yet.
					</div>
				) : (
					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
						{videosWithThumbs.map((v) => {
							const aspect =
								v.width && v.height ? v.width / v.height : 16 / 9;
							return (
								<Link
									key={v.id}
									href={`/s/${v.id}`}
									className="group flex flex-col rounded-xl border border-gray-3 bg-gray-2 hover:border-blue-10 hover:shadow-md transition-all overflow-hidden"
								>
									<div
										className="relative w-full bg-gray-4 overflow-hidden"
										style={{ paddingBottom: `${(1 / aspect) * 100}%` }}
									>
										{v.thumbnailUrl ? (
											// eslint-disable-next-line @next/next/no-img-element
											<img
												src={v.thumbnailUrl}
												alt={v.name}
												className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
												loading="lazy"
											/>
										) : (
											<div className="absolute inset-0 flex items-center justify-center text-xs text-gray-9">
												No preview
											</div>
										)}
										{v.duration ? (
											<div className="absolute bottom-2 right-2 rounded bg-black/75 px-1.5 py-0.5 text-xs font-medium text-white">
												{formatDuration(Number(v.duration))}
											</div>
										) : null}
									</div>
									<div className="p-4">
										<p className="text-sm font-medium text-gray-12 truncate group-hover:text-blue-10">
											{v.name}
										</p>
										<p className="text-xs text-gray-10 mt-1">
											{new Date(v.createdAt).toLocaleDateString(undefined, {
												day: "numeric",
												month: "long",
												year: "numeric",
											})}
										</p>
									</div>
								</Link>
							);
						})}
					</div>
				)}
			</main>
		</div>
	);
}
