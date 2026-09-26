import { getCurrentUser } from "@cap/database/auth/session";
import { Video } from "@cap/web-domain";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { loadOwnedRenderExports } from "@/lib/render-farm-download";
import { pickRenderExport } from "@/lib/render-farm-status";
import { ExportRefresh } from "./ExportRefresh";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Download export",
	robots: { index: false, follow: false },
};

function formatBytes(bytes: number) {
	return bytes >= 1024 * 1024 * 1024
		? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
		: `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

export default async function ExportDownloadPage(props: {
	params: Promise<{ videoId: string }>;
	searchParams: Promise<{ export?: string | string[] }>;
}) {
	const { videoId: rawVideoId } = await props.params;
	const { export: rawExportId } = await props.searchParams;
	const videoId = Video.VideoId.make(rawVideoId);
	const exportId = typeof rawExportId === "string" ? rawExportId : null;
	const query = exportId ? `?export=${encodeURIComponent(exportId)}` : "";
	const user = await getCurrentUser();
	if (!user) {
		redirect(
			`/login?next=${encodeURIComponent(`/s/${videoId}/download${query}`)}`,
		);
	}
	const loaded = await loadOwnedRenderExports(videoId, user);
	if (!loaded) notFound();
	const item = pickRenderExport(loaded.exports, exportId);
	const shareUrl = `/s/${encodeURIComponent(videoId)}`;

	return (
		<main className="flex min-h-screen items-center justify-center bg-gray-2 p-6">
			<div className="w-full max-w-md space-y-4 rounded-xl border border-gray-5 bg-gray-1 p-6">
				<h1 className="text-xl font-medium text-gray-12">
					{item?.state === "ready"
						? "Your export is ready"
						: item?.state === "rendering"
							? "Exporting your video"
							: item?.state === "expired"
								? "This export has expired"
								: item?.state === "error"
									? "This export failed"
									: "Export not found"}
				</h1>
				<output className="block text-sm text-gray-11">
					{item?.state === "ready"
						? `${item.fileName} · ${item.resolution[0]}×${item.resolution[1]} · ${item.fps} fps${item.bytes ? ` · ${formatBytes(item.bytes)}` : ""}`
						: item?.state === "rendering"
							? "This page updates by itself, and we'll email you when the download is ready."
							: item?.state === "expired"
								? "Exports stay available for 7 days. Open the editor to export it again."
								: item?.state === "error"
									? (item.error ?? "Export failed")
									: "We couldn't find this export. Open the editor to export again."}
				</output>
				{item?.state === "rendering" && <ExportRefresh />}
				<div className="flex flex-wrap items-center gap-3">
					{item?.state === "ready" && (
						<a
							href={`/s/${encodeURIComponent(videoId)}/download/file?export=${encodeURIComponent(item.exportId)}`}
							className="rounded-lg bg-blue-9 px-4 py-2 text-sm font-medium text-white"
						>
							Download
						</a>
					)}
					{item && item.state !== "ready" && item.state !== "rendering" && (
						<a
							href={`${shareUrl}/edit`}
							className="rounded-lg bg-blue-9 px-4 py-2 text-sm font-medium text-white"
						>
							Open editor
						</a>
					)}
					<a href={shareUrl} className="text-sm text-blue-11 underline">
						Back to video
					</a>
				</div>
			</div>
		</main>
	);
}
