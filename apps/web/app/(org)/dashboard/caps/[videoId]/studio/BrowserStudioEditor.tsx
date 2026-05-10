"use client";

import {
	faArrowLeft,
	faCheck,
	faMagnifyingGlassPlus,
	faPause,
	faPlay,
	faUpload,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	type BrowserStudioCanvasAspectRatio,
	type BrowserStudioCloudManifest,
	type BrowserStudioEditSettings,
	type BrowserStudioSource,
	getBrowserStudioEditSettings,
	normalizeBrowserStudioManifest,
} from "@/lib/browser-studio";

type BrowserStudioEditorProps = {
	videoId: string;
	title: string;
	shareUrl: string;
};

type BrowserStudioPayload = {
	manifest: BrowserStudioCloudManifest;
	sources: BrowserStudioSource[];
};

const aspectRatioOptions = [
	{ value: "source", label: "Source" },
	{ value: "16:9", label: "16:9" },
	{ value: "1:1", label: "1:1" },
	{ value: "9:16", label: "9:16" },
] satisfies {
	value: BrowserStudioCanvasAspectRatio;
	label: string;
}[];

const backgroundOptions = [
	"#111111",
	"#f8f8f7",
	"#183d3d",
	"#7c2d12",
	"#1d4ed8",
	"#701a75",
];

const clamp = (value: number, min: number, max: number) =>
	Math.min(Math.max(value, min), max);

const formatTime = (ms: number | null | undefined) => {
	if (!ms || ms <= 0) return "0:00";
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const getAspectRatioValue = (
	aspectRatio: BrowserStudioCanvasAspectRatio,
	sourceRatio: number,
) => {
	if (aspectRatio === "16:9") return 16 / 9;
	if (aspectRatio === "1:1") return 1;
	if (aspectRatio === "9:16") return 9 / 16;
	return sourceRatio;
};

export function BrowserStudioEditor({
	videoId,
	title,
	shareUrl,
}: BrowserStudioEditorProps) {
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const backgroundVideoRef = useRef<HTMLVideoElement | null>(null);
	const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
	const previewRef = useRef<HTMLButtonElement | null>(null);
	const [manifest, setManifest] = useState<BrowserStudioCloudManifest | null>(
		null,
	);
	const [sources, setSources] = useState<BrowserStudioSource[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [exporting, setExporting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [mediaDurationMs, setMediaDurationMs] = useState<number | null>(null);
	const [playing, setPlaying] = useState(false);
	const [activeAssetId, setActiveAssetId] = useState<string | null>(null);
	const [currentMs, setCurrentMs] = useState(0);
	const [zoomToolArmed, setZoomToolArmed] = useState(false);
	const [selectedZoomId, setSelectedZoomId] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;

		const loadStudio = async () => {
			setLoading(true);
			setError(null);

			try {
				const response = await fetch(
					`/api/video/studio?videoId=${encodeURIComponent(videoId)}`,
					{ credentials: "same-origin" },
				);

				if (!response.ok) {
					throw new Error("Studio project could not be loaded");
				}

				const payload = (await response.json()) as BrowserStudioPayload;
				if (cancelled) return;

				const nextManifest = normalizeBrowserStudioManifest(payload.manifest);
				setManifest(nextManifest);
				setSources(payload.sources);
				setActiveAssetId(nextManifest.assets[0]?.assetId ?? null);
			} catch (loadError) {
				if (cancelled) return;
				console.error("Failed to load Browser Studio", loadError);
				setError("Studio project could not be loaded.");
			} finally {
				if (!cancelled) setLoading(false);
			}
		};

		void loadStudio();

		return () => {
			cancelled = true;
		};
	}, [videoId]);

	const edit = useMemo(
		() => (manifest ? getBrowserStudioEditSettings(manifest) : null),
		[manifest],
	);
	const activeAsset = useMemo(
		() =>
			manifest?.assets.find((asset) => asset.assetId === activeAssetId) ??
			manifest?.assets[0] ??
			null,
		[manifest, activeAssetId],
	);
	const activeSource = useMemo(() => {
		if (!manifest) return sources[0] ?? null;
		const subpath = activeAsset?.sourceSubpath;
		return (
			sources.find((source) => source.subpath === subpath) ?? sources[0] ?? null
		);
	}, [manifest, sources, activeAsset]);
	const primaryAsset = useMemo(
		() =>
			manifest?.assets.find(
				(asset) => asset.kind === "screen" || asset.kind === "mixed",
			) ??
			manifest?.assets[0] ??
			null,
		[manifest],
	);
	const primarySource = useMemo(
		() =>
			sources.find(
				(source) => source.subpath === primaryAsset?.sourceSubpath,
			) ?? activeSource,
		[sources, primaryAsset, activeSource],
	);
	const cameraAsset = useMemo(
		() => manifest?.assets.find((asset) => asset.kind === "camera") ?? null,
		[manifest],
	);
	const cameraTrack = useMemo(
		() =>
			manifest?.project.timeline.tracks.find(
				(track) => track.assetId === cameraAsset?.assetId,
			) ?? null,
		[manifest, cameraAsset],
	);
	const cameraSource = useMemo(
		() =>
			cameraTrack?.muted
				? null
				: (sources.find(
						(source) => source.subpath === cameraAsset?.sourceSubpath,
					) ?? null),
		[sources, cameraAsset, cameraTrack],
	);
	const durationMs =
		manifest?.project.timeline.durationMs ?? mediaDurationMs ?? 0;
	const trimStartMs = edit?.trim.startMs ?? 0;
	const trimEndMs = edit?.trim.endMs ?? durationMs;
	const sourceRatio =
		activeAsset?.width && activeAsset.height
			? activeAsset.width / activeAsset.height
			: 16 / 9;
	const canvasRatio = getAspectRatioValue(
		edit?.canvas.aspectRatio ?? "source",
		sourceRatio,
	);
	const sortedZooms = useMemo(
		() => [...(edit?.zooms ?? [])].sort((a, b) => a.startMs - b.startMs),
		[edit],
	);
	const selectedZoom = useMemo(
		() => sortedZooms.find((zoom) => zoom.id === selectedZoomId) ?? null,
		[sortedZooms, selectedZoomId],
	);
	const activeZoom = useMemo(() => {
		for (let index = sortedZooms.length - 1; index >= 0; index -= 1) {
			const zoom = sortedZooms[index];
			if (zoom && currentMs >= zoom.startMs && currentMs <= zoom.endMs) {
				return zoom;
			}
		}
		return null;
	}, [sortedZooms, currentMs]);
	const previewScale = edit ? edit.canvas.scale * (activeZoom?.scale ?? 1) : 1;
	const previewOriginX = activeZoom?.originX ?? 0.5;
	const previewOriginY = activeZoom?.originY ?? 0.5;

	const updateEdit = useCallback(
		(
			updater: (edit: BrowserStudioEditSettings) => BrowserStudioEditSettings,
		) => {
			setManifest((current) =>
				current
					? {
							...current,
							updatedAt: Date.now(),
							edit: updater(getBrowserStudioEditSettings(current)),
						}
					: current,
			);
		},
		[],
	);

	const setTrimStart = (value: number) => {
		updateEdit((current) => {
			const maxStart = Math.max(0, (current.trim.endMs ?? durationMs) - 500);
			return {
				...current,
				trim: {
					...current.trim,
					startMs: clamp(value, 0, maxStart),
				},
			};
		});
	};

	const setTrimEnd = (value: number) => {
		updateEdit((current) => ({
			...current,
			trim: {
				...current.trim,
				endMs: clamp(value, current.trim.startMs + 500, durationMs),
			},
		}));
	};

	const updateZoom = (
		zoomId: string,
		updater: (
			zoom: BrowserStudioEditSettings["zooms"][number],
		) => BrowserStudioEditSettings["zooms"][number],
	) => {
		updateEdit((current) => ({
			...current,
			zooms: current.zooms.map((zoom) =>
				zoom.id === zoomId ? updater(zoom) : zoom,
			),
		}));
	};

	const removeZoom = (zoomId: string) => {
		updateEdit((current) => ({
			...current,
			zooms: current.zooms.filter((zoom) => zoom.id !== zoomId),
		}));
		setSelectedZoomId((current) => (current === zoomId ? null : current));
	};

	const createZoomAtPoint = (originX: number, originY: number) => {
		if (!edit) return;

		const playheadMs = clamp(
			Math.round(
				videoRef.current?.currentTime
					? videoRef.current.currentTime * 1000
					: currentMs,
			),
			trimStartMs,
			trimEndMs,
		);
		const startMs = clamp(playheadMs - 500, trimStartMs, trimEndMs - 500);
		const endMs = clamp(startMs + 2500, startMs + 500, trimEndMs);
		const id =
			typeof crypto !== "undefined" && "randomUUID" in crypto
				? crypto.randomUUID()
				: `zoom-${Date.now()}`;

		updateEdit((current) => ({
			...current,
			zooms: [
				...current.zooms,
				{
					id,
					startMs,
					endMs,
					scale: 1.8,
					originX: clamp(originX, 0.05, 0.95),
					originY: clamp(originY, 0.05, 0.95),
				},
			],
		}));
		setSelectedZoomId(id);
		setZoomToolArmed(false);
		toast.success("Zoom segment added");
	};

	const handlePreviewClick = (event: React.MouseEvent<HTMLButtonElement>) => {
		if (!zoomToolArmed || !previewRef.current) return;

		const rect = previewRef.current.getBoundingClientRect();
		createZoomAtPoint(
			(event.clientX - rect.left) / rect.width,
			(event.clientY - rect.top) / rect.height,
		);
	};

	const toggleTrackMuted = (trackId: string) => {
		setManifest((current) =>
			current
				? {
						...current,
						updatedAt: Date.now(),
						project: {
							...current.project,
							timeline: {
								...current.project.timeline,
								tracks: current.project.timeline.tracks.map((track) =>
									track.trackId === trackId
										? { ...track, muted: !track.muted }
										: track,
								),
							},
						},
					}
				: current,
		);
	};

	const saveProject = async () => {
		if (!manifest || saving || exporting) return;

		setSaving(true);

		try {
			const response = await fetch("/api/video/studio", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify({ videoId, manifest }),
			});

			if (!response.ok) {
				throw new Error("Studio project could not be saved");
			}

			const payload = (await response.json()) as {
				manifest: BrowserStudioCloudManifest;
			};
			const nextManifest = normalizeBrowserStudioManifest(payload.manifest);
			setManifest(nextManifest);
			setActiveAssetId(
				(current) => current ?? nextManifest.assets[0]?.assetId ?? null,
			);
			toast.success("Studio project saved");
		} catch (saveError) {
			console.error("Failed to save Browser Studio project", saveError);
			toast.error("Could not save Studio project");
		} finally {
			setSaving(false);
		}
	};

	const exportProject = async () => {
		if (!manifest || saving || exporting) return;

		setExporting(true);

		try {
			const response = await fetch("/api/video/studio/render", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify({ videoId, manifest }),
			});

			if (!response.ok) {
				throw new Error("Studio project could not be exported");
			}

			const payload = (await response.json()) as {
				manifest: BrowserStudioCloudManifest;
			};
			const nextManifest = normalizeBrowserStudioManifest(payload.manifest);
			setManifest(nextManifest);
			setActiveAssetId(
				(current) => current ?? nextManifest.assets[0]?.assetId ?? null,
			);
			toast.success("Share video updated");
		} catch (exportError) {
			console.error("Failed to export Browser Studio project", exportError);
			toast.error("Could not update share video");
		} finally {
			setExporting(false);
		}
	};

	const togglePlayback = async () => {
		const video = videoRef.current;
		if (!video) return;

		if (video.paused) {
			const currentMs = video.currentTime * 1000;
			if (currentMs < trimStartMs || currentMs >= trimEndMs) {
				video.currentTime = trimStartMs / 1000;
				if (backgroundVideoRef.current) {
					backgroundVideoRef.current.currentTime = trimStartMs / 1000;
				}
				if (cameraVideoRef.current) {
					cameraVideoRef.current.currentTime = trimStartMs / 1000;
				}
			}
			await video.play();
			await backgroundVideoRef.current?.play().catch(() => undefined);
			await cameraVideoRef.current?.play().catch(() => undefined);
			setPlaying(true);
			return;
		}

		video.pause();
		backgroundVideoRef.current?.pause();
		cameraVideoRef.current?.pause();
		setPlaying(false);
	};

	useEffect(() => {
		const video = videoRef.current;
		if (!video || !edit) return;

		const handleTimeUpdate = () => {
			const currentMs = video.currentTime * 1000;
			setCurrentMs(currentMs);
			const backgroundVideo = backgroundVideoRef.current;
			if (
				backgroundVideo &&
				Math.abs(backgroundVideo.currentTime - video.currentTime) > 0.25
			) {
				backgroundVideo.currentTime = video.currentTime;
			}
			const cameraVideo = cameraVideoRef.current;
			if (
				cameraVideo &&
				Math.abs(cameraVideo.currentTime - video.currentTime) > 0.25
			) {
				cameraVideo.currentTime = video.currentTime;
			}
			if (currentMs >= (edit.trim.endMs ?? durationMs)) {
				video.pause();
				backgroundVideo?.pause();
				cameraVideo?.pause();
				video.currentTime = edit.trim.startMs / 1000;
				if (backgroundVideo) {
					backgroundVideo.currentTime = edit.trim.startMs / 1000;
				}
				if (cameraVideo) {
					cameraVideo.currentTime = edit.trim.startMs / 1000;
				}
				setCurrentMs(edit.trim.startMs);
				setPlaying(false);
			}
		};
		const handlePlay = () => setPlaying(true);
		const handlePause = () => {
			backgroundVideoRef.current?.pause();
			cameraVideoRef.current?.pause();
			setPlaying(false);
		};

		video.addEventListener("timeupdate", handleTimeUpdate);
		video.addEventListener("play", handlePlay);
		video.addEventListener("pause", handlePause);

		return () => {
			video.removeEventListener("timeupdate", handleTimeUpdate);
			video.removeEventListener("play", handlePlay);
			video.removeEventListener("pause", handlePause);
		};
	}, [edit, durationMs]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video || !edit) return;
		video.volume = edit.audio.volume;
	}, [edit]);

	if (loading) {
		return (
			<div className="min-h-screen bg-gray-1 p-6">
				<div className="h-8 w-48 rounded-lg bg-gray-4" />
				<div className="mt-8 grid gap-6 lg:grid-cols-[1fr_360px]">
					<div className="aspect-video rounded-xl bg-gray-3" />
					<div className="h-[520px] rounded-xl bg-gray-3" />
				</div>
			</div>
		);
	}

	if (error || !manifest || !edit || !activeSource || !primarySource) {
		return (
			<div className="flex min-h-screen items-center justify-center bg-gray-1 p-6">
				<div className="w-full max-w-md rounded-xl border border-gray-4 bg-gray-2 p-6">
					<p className="text-lg font-semibold text-gray-12">
						{error ?? "Studio project is unavailable."}
					</p>
					<Link
						href="/dashboard/caps"
						className="mt-5 inline-flex items-center gap-2 rounded-full bg-gray-12 px-4 py-2 text-sm font-medium text-gray-1"
					>
						<FontAwesomeIcon className="size-3" icon={faArrowLeft} />
						Back to videos
					</Link>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-gray-1 text-gray-12">
			<header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-3 px-5 py-4">
				<div className="flex min-w-0 items-center gap-3">
					<Link
						href="/dashboard/caps"
						className="inline-flex size-9 items-center justify-center rounded-full bg-gray-3 text-gray-12 hover:bg-gray-4"
						aria-label="Back to videos"
					>
						<FontAwesomeIcon className="size-3" icon={faArrowLeft} />
					</Link>
					<div className="min-w-0">
						<h1 className="truncate text-xl font-semibold">{title}</h1>
						<p className="text-sm text-gray-9">Browser Studio</p>
					</div>
				</div>
				<div className="flex items-center gap-2">
					<Link
						href={shareUrl}
						className="rounded-full border border-gray-4 px-4 py-2 text-sm font-medium text-gray-12 hover:bg-gray-3"
					>
						Open share
					</Link>
					<button
						type="button"
						onClick={saveProject}
						disabled={saving || exporting}
						className="inline-flex items-center gap-2 rounded-full bg-gray-12 px-4 py-2 text-sm font-medium text-gray-1 disabled:opacity-50"
					>
						<FontAwesomeIcon className="size-3" icon={faCheck} />
						{saving ? "Saving" : "Save project"}
					</button>
					<button
						type="button"
						onClick={exportProject}
						disabled={saving || exporting}
						className="inline-flex items-center gap-2 rounded-full bg-blue-10 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
					>
						<FontAwesomeIcon className="size-3" icon={faUpload} />
						{exporting ? "Exporting" : "Export to share"}
					</button>
				</div>
			</header>

			<main className="grid gap-5 p-5 xl:grid-cols-[1fr_380px]">
				<section className="min-w-0">
					<button
						type="button"
						ref={previewRef}
						onClick={handlePreviewClick}
						onKeyDown={(event) => {
							if (!zoomToolArmed) return;
							if (event.key !== "Enter" && event.key !== " ") return;
							event.preventDefault();
							createZoomAtPoint(0.5, 0.5);
						}}
						className="relative mx-auto flex w-full max-w-6xl items-center justify-center overflow-hidden rounded-xl shadow-sm"
						style={{
							aspectRatio: canvasRatio,
							background:
								edit.canvas.backgroundMode === "solid"
									? edit.canvas.background
									: "#111111",
							padding: `${edit.canvas.padding}%`,
							cursor: zoomToolArmed ? "crosshair" : "default",
						}}
					>
						{edit.canvas.backgroundMode === "blur" && (
							<video
								key={`background-${primarySource.url}`}
								ref={backgroundVideoRef}
								src={primarySource.url}
								className="pointer-events-none absolute inset-0 size-full scale-110 object-cover opacity-80 blur-2xl"
								muted
								playsInline
								tabIndex={-1}
								aria-hidden="true"
							>
								<track kind="captions" />
							</video>
						)}
						<video
							key={primarySource.url}
							ref={videoRef}
							src={primarySource.url}
							className="relative z-10 max-h-full max-w-full rounded-lg bg-black object-contain shadow-lg"
							style={{
								transform: `scale(${previewScale})`,
								transformOrigin: `${previewOriginX * 100}% ${previewOriginY * 100}%`,
								width: "100%",
							}}
							playsInline
							onLoadedMetadata={(event) => {
								setMediaDurationMs(event.currentTarget.duration * 1000);
								setCurrentMs(event.currentTarget.currentTime * 1000);
								if (backgroundVideoRef.current) {
									backgroundVideoRef.current.currentTime =
										event.currentTarget.currentTime;
								}
								if (cameraVideoRef.current) {
									cameraVideoRef.current.currentTime =
										event.currentTarget.currentTime;
								}
							}}
						>
							<track kind="captions" />
						</video>
						{cameraSource && (
							<video
								key={`camera-${cameraSource.url}`}
								ref={cameraVideoRef}
								src={cameraSource.url}
								className="pointer-events-none absolute z-20 rounded-2xl object-cover shadow-2xl ring-2 ring-white/70"
								muted
								playsInline
								tabIndex={-1}
								aria-hidden="true"
								style={{
									width: `${edit.canvas.cameraSize}%`,
									aspectRatio: "1 / 1",
									...(edit.canvas.cameraPosition === "top-left"
										? { left: "4%", top: "4%" }
										: {}),
									...(edit.canvas.cameraPosition === "top-right"
										? { right: "4%", top: "4%" }
										: {}),
									...(edit.canvas.cameraPosition === "bottom-left"
										? { bottom: "4%", left: "4%" }
										: {}),
									...(edit.canvas.cameraPosition === "bottom-right"
										? { bottom: "4%", right: "4%" }
										: {}),
								}}
							>
								<track kind="captions" />
							</video>
						)}
					</button>

					<div className="mt-4 rounded-xl border border-gray-3 bg-gray-2 p-4">
						<div className="flex flex-wrap items-center gap-3">
							<button
								type="button"
								onClick={togglePlayback}
								className="inline-flex size-10 items-center justify-center rounded-full bg-gray-12 text-gray-1"
								aria-label={playing ? "Pause" : "Play"}
							>
								<FontAwesomeIcon
									className="size-3"
									icon={playing ? faPause : faPlay}
								/>
							</button>
							<div className="text-sm font-medium text-gray-10">
								{formatTime(trimStartMs)} to {formatTime(trimEndMs)}
							</div>
							<button
								type="button"
								onClick={() => setZoomToolArmed((current) => !current)}
								className={clsx(
									"inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium",
									zoomToolArmed
										? "bg-blue-10 text-white"
										: "bg-gray-4 text-gray-12",
								)}
							>
								<FontAwesomeIcon
									className="size-3"
									icon={faMagnifyingGlassPlus}
								/>
								{zoomToolArmed ? "Click preview" : "Add zoom"}
							</button>
						</div>

						<div className="mt-5 space-y-3">
							{manifest.project.timeline.tracks.map((track) => {
								const trackDuration = track.durationMs ?? durationMs;
								const widthPercent =
									durationMs > 0 ? (trackDuration / durationMs) * 100 : 100;
								const isActive = track.assetId === activeAsset?.assetId;

								return (
									<div key={track.trackId} className="grid gap-2">
										<div className="flex items-center justify-between gap-2 text-xs font-medium uppercase tracking-wide text-gray-9">
											<button
												type="button"
												onClick={() => setActiveAssetId(track.assetId)}
												className={clsx(
													"truncate text-left",
													isActive ? "text-blue-11" : "text-gray-9",
												)}
											>
												{track.label}
											</button>
											<div className="flex items-center gap-2">
												<span>{track.kind}</span>
												<button
													type="button"
													onClick={() => toggleTrackMuted(track.trackId)}
													className={clsx(
														"rounded-full px-2 py-1 text-[0.65rem] font-semibold",
														track.muted
															? "bg-red-4 text-red-11"
															: "bg-gray-4 text-gray-11",
													)}
												>
													{track.muted ? "Muted" : "On"}
												</button>
											</div>
										</div>
										<button
											type="button"
											onClick={() => setActiveAssetId(track.assetId)}
											className={clsx(
												"h-9 overflow-hidden rounded-lg bg-gray-4 text-left",
												isActive && "ring-2 ring-blue-10",
											)}
											aria-label={`Preview ${track.label}`}
										>
											<div
												className={clsx(
													"h-full rounded-lg",
													track.muted ? "bg-gray-8" : "bg-blue-10",
												)}
												style={{ width: `${clamp(widthPercent, 4, 100)}%` }}
											/>
										</button>
									</div>
								);
							})}
						</div>
					</div>
				</section>

				<aside className="space-y-4">
					<section className="rounded-xl border border-gray-3 bg-gray-2 p-4">
						<h2 className="text-sm font-semibold uppercase tracking-wide text-gray-9">
							Trim
						</h2>
						<div className="mt-4 grid gap-4">
							<label className="grid gap-2 text-sm font-medium text-gray-11">
								Start
								<input
									type="range"
									min={0}
									max={durationMs}
									step={100}
									value={trimStartMs}
									onChange={(event) =>
										setTrimStart(Number(event.currentTarget.value))
									}
									className="w-full"
								/>
								<span className="text-xs text-gray-9">
									{formatTime(trimStartMs)}
								</span>
							</label>
							<label className="grid gap-2 text-sm font-medium text-gray-11">
								End
								<input
									type="range"
									min={0}
									max={durationMs}
									step={100}
									value={trimEndMs}
									onChange={(event) =>
										setTrimEnd(Number(event.currentTarget.value))
									}
									className="w-full"
								/>
								<span className="text-xs text-gray-9">
									{formatTime(trimEndMs)}
								</span>
							</label>
						</div>
					</section>

					<section className="rounded-xl border border-gray-3 bg-gray-2 p-4">
						<h2 className="text-sm font-semibold uppercase tracking-wide text-gray-9">
							Canvas
						</h2>
						<div className="mt-4 grid grid-cols-4 gap-2">
							{aspectRatioOptions.map((option) => (
								<button
									key={option.value}
									type="button"
									onClick={() =>
										updateEdit((current) => ({
											...current,
											canvas: {
												...current.canvas,
												aspectRatio: option.value,
											},
										}))
									}
									className={clsx(
										"rounded-lg border px-3 py-2 text-sm font-medium",
										edit.canvas.aspectRatio === option.value
											? "border-blue-10 bg-blue-10 text-white"
											: "border-gray-4 bg-gray-1 text-gray-11 hover:bg-gray-3",
									)}
								>
									{option.label}
								</button>
							))}
						</div>

						<div className="mt-5 grid gap-4">
							<label className="grid gap-2 text-sm font-medium text-gray-11">
								Padding
								<input
									type="range"
									min={0}
									max={18}
									step={1}
									value={edit.canvas.padding}
									onChange={(event) =>
										updateEdit((current) => ({
											...current,
											canvas: {
												...current.canvas,
												padding: Number(event.currentTarget.value),
											},
										}))
									}
									className="w-full"
								/>
							</label>
							<label className="grid gap-2 text-sm font-medium text-gray-11">
								Scale
								<input
									type="range"
									min={0.8}
									max={1.4}
									step={0.01}
									value={edit.canvas.scale}
									onChange={(event) =>
										updateEdit((current) => ({
											...current,
											canvas: {
												...current.canvas,
												scale: Number(event.currentTarget.value),
											},
										}))
									}
									className="w-full"
								/>
							</label>
							<label className="grid gap-2 text-sm font-medium text-gray-11">
								Volume
								<input
									type="range"
									min={0}
									max={1}
									step={0.01}
									value={edit.audio.volume}
									onChange={(event) =>
										updateEdit((current) => ({
											...current,
											audio: {
												...current.audio,
												volume: Number(event.currentTarget.value),
											},
										}))
									}
									className="w-full"
								/>
							</label>
						</div>

						<div className="mt-5">
							<div className="mb-2 flex items-center justify-between gap-3 text-sm font-medium text-gray-11">
								Background
								<div className="rounded-full bg-gray-4 p-1">
									<button
										type="button"
										onClick={() =>
											updateEdit((current) => ({
												...current,
												canvas: {
													...current.canvas,
													backgroundMode: "solid",
												},
											}))
										}
										className={clsx(
											"rounded-full px-2.5 py-1 text-xs font-semibold",
											edit.canvas.backgroundMode === "solid"
												? "bg-white text-gray-12 shadow-sm"
												: "text-gray-10",
										)}
									>
										Solid
									</button>
									<button
										type="button"
										onClick={() =>
											updateEdit((current) => ({
												...current,
												canvas: {
													...current.canvas,
													backgroundMode: "blur",
												},
											}))
										}
										className={clsx(
											"rounded-full px-2.5 py-1 text-xs font-semibold",
											edit.canvas.backgroundMode === "blur"
												? "bg-white text-gray-12 shadow-sm"
												: "text-gray-10",
										)}
									>
										Blur
									</button>
								</div>
							</div>
							<div className="flex flex-wrap gap-2">
								{backgroundOptions.map((color) => (
									<button
										key={color}
										type="button"
										onClick={() =>
											updateEdit((current) => ({
												...current,
												canvas: {
													...current.canvas,
													background: color,
												},
											}))
										}
										className={clsx(
											"size-8 rounded-full border",
											edit.canvas.background === color
												? "border-blue-10 ring-2 ring-blue-10/30"
												: "border-gray-5",
										)}
										style={{ background: color }}
										aria-label={`Set background ${color}`}
									/>
								))}
							</div>
						</div>
					</section>

					<section className="rounded-xl border border-gray-3 bg-gray-2 p-4">
						<h2 className="text-sm font-semibold uppercase tracking-wide text-gray-9">
							Camera
						</h2>
						{cameraAsset ? (
							<div className="mt-4 grid gap-4">
								<div className="grid grid-cols-2 gap-2">
									{[
										{ value: "top-left", label: "Top left" },
										{ value: "top-right", label: "Top right" },
										{ value: "bottom-left", label: "Bottom left" },
										{ value: "bottom-right", label: "Bottom right" },
									].map((option) => (
										<button
											key={option.value}
											type="button"
											onClick={() =>
												updateEdit((current) => ({
													...current,
													canvas: {
														...current.canvas,
														cameraPosition:
															option.value as BrowserStudioEditSettings["canvas"]["cameraPosition"],
													},
												}))
											}
											className={clsx(
												"rounded-lg border px-3 py-2 text-sm font-medium",
												edit.canvas.cameraPosition === option.value
													? "border-blue-10 bg-blue-10 text-white"
													: "border-gray-4 bg-gray-1 text-gray-11 hover:bg-gray-3",
											)}
										>
											{option.label}
										</button>
									))}
								</div>
								<label className="grid gap-2 text-sm font-medium text-gray-11">
									Size
									<input
										type="range"
										min={10}
										max={40}
										step={1}
										value={edit.canvas.cameraSize}
										onChange={(event) =>
											updateEdit((current) => ({
												...current,
												canvas: {
													...current.canvas,
													cameraSize: Number(event.currentTarget.value),
												},
											}))
										}
										className="w-full"
									/>
									<span className="text-xs text-gray-9">
										{edit.canvas.cameraSize}%
									</span>
								</label>
								{cameraTrack && (
									<button
										type="button"
										onClick={() => toggleTrackMuted(cameraTrack.trackId)}
										className={clsx(
											"rounded-full px-3 py-2 text-sm font-semibold",
											cameraTrack.muted
												? "bg-red-4 text-red-11"
												: "bg-gray-4 text-gray-11",
										)}
									>
										{cameraTrack.muted ? "Camera hidden" : "Camera visible"}
									</button>
								)}
							</div>
						) : (
							<p className="mt-3 text-sm text-gray-9">
								This recording does not include a separate camera track.
							</p>
						)}
					</section>

					<section className="rounded-xl border border-gray-3 bg-gray-2 p-4">
						<div className="flex items-center justify-between gap-3">
							<h2 className="text-sm font-semibold uppercase tracking-wide text-gray-9">
								Zooms
							</h2>
							<button
								type="button"
								onClick={() => setZoomToolArmed((current) => !current)}
								className={clsx(
									"rounded-full px-3 py-1.5 text-xs font-semibold",
									zoomToolArmed
										? "bg-blue-10 text-white"
										: "bg-gray-4 text-gray-11",
								)}
							>
								{zoomToolArmed ? "Pick point" : "Add"}
							</button>
						</div>
						{sortedZooms.length === 0 ? (
							<p className="mt-3 text-sm text-gray-9">
								Add a zoom, then click the preview where attention should go.
							</p>
						) : (
							<div className="mt-4 space-y-3">
								{sortedZooms.map((zoom, index) => (
									<button
										key={zoom.id}
										type="button"
										onClick={() => setSelectedZoomId(zoom.id)}
										className={clsx(
											"w-full rounded-lg border px-3 py-2 text-left",
											selectedZoomId === zoom.id
												? "border-blue-10 bg-blue-3"
												: "border-gray-4 bg-gray-1 hover:bg-gray-3",
										)}
									>
										<div className="flex items-center justify-between gap-3 text-sm font-medium text-gray-12">
											<span>Zoom {index + 1}</span>
											<span>{zoom.scale.toFixed(1)}x</span>
										</div>
										<div className="mt-1 text-xs text-gray-9">
											{formatTime(zoom.startMs)} to {formatTime(zoom.endMs)}
										</div>
									</button>
								))}
							</div>
						)}
						{selectedZoom && (
							<div className="mt-5 grid gap-4 border-t border-gray-4 pt-4">
								<label className="grid gap-2 text-sm font-medium text-gray-11">
									Scale
									<input
										type="range"
										min={1.1}
										max={4}
										step={0.1}
										value={selectedZoom.scale}
										onChange={(event) =>
											updateZoom(selectedZoom.id, (zoom) => ({
												...zoom,
												scale: Number(event.currentTarget.value),
											}))
										}
										className="w-full"
									/>
								</label>
								<label className="grid gap-2 text-sm font-medium text-gray-11">
									Start
									<input
										type="range"
										min={trimStartMs}
										max={Math.max(trimStartMs, selectedZoom.endMs - 500)}
										step={100}
										value={selectedZoom.startMs}
										onChange={(event) =>
											updateZoom(selectedZoom.id, (zoom) => ({
												...zoom,
												startMs: clamp(
													Number(event.currentTarget.value),
													trimStartMs,
													zoom.endMs - 500,
												),
											}))
										}
										className="w-full"
									/>
									<span className="text-xs text-gray-9">
										{formatTime(selectedZoom.startMs)}
									</span>
								</label>
								<label className="grid gap-2 text-sm font-medium text-gray-11">
									End
									<input
										type="range"
										min={selectedZoom.startMs + 500}
										max={trimEndMs}
										step={100}
										value={selectedZoom.endMs}
										onChange={(event) =>
											updateZoom(selectedZoom.id, (zoom) => ({
												...zoom,
												endMs: clamp(
													Number(event.currentTarget.value),
													zoom.startMs + 500,
													trimEndMs,
												),
											}))
										}
										className="w-full"
									/>
									<span className="text-xs text-gray-9">
										{formatTime(selectedZoom.endMs)}
									</span>
								</label>
								<button
									type="button"
									onClick={() => removeZoom(selectedZoom.id)}
									className="rounded-full bg-red-4 px-3 py-2 text-sm font-semibold text-red-11"
								>
									Remove zoom
								</button>
							</div>
						)}
					</section>

					<section className="rounded-xl border border-gray-3 bg-gray-2 p-4">
						<h2 className="text-sm font-semibold uppercase tracking-wide text-gray-9">
							Source
						</h2>
						<div className="mt-3 space-y-2 text-sm text-gray-10">
							<div className="flex justify-between gap-3">
								<span>File</span>
								<span className="truncate text-gray-12">
									{activeSource.subpath}
								</span>
							</div>
							<div className="flex justify-between gap-3">
								<span>Size</span>
								<span className="text-gray-12">
									{activeSource.size
										? `${(activeSource.size / 1024 / 1024).toFixed(1)} MB`
										: "Unknown"}
								</span>
							</div>
							<div className="flex justify-between gap-3">
								<span>Duration</span>
								<span className="text-gray-12">{formatTime(durationMs)}</span>
							</div>
						</div>
					</section>
				</aside>
			</main>
		</div>
	);
}
