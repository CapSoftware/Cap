"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WebEditorCapImportProgress } from "@/lib/editor-cap-import-client";
import {
	hasEditorCaptionContent,
	stripEditorCaptionContent,
} from "@/lib/editor-caption-access";
import type { EditorClipCapture } from "@/lib/editor-clip-recorder";
import {
	captureEditorLocalDraft,
	clearEditorLocalDraft,
	type EditorLocalDraft,
	readEditorLocalDraft,
} from "@/lib/editor-local-draft";
import type { WebEditorVideoImportProgress } from "@/lib/editor-video-import-client";
import { EditorClipRecorder } from "./EditorClipRecorder";
import { EditorHostBridge } from "./editor-host";

const UpgradeModal = dynamic(
	() =>
		import("@/components/UpgradeModal").then((module) => module.UpgradeModal),
	{ ssr: false },
);

type Preparation = { id: string; status: "preparing" };
type PreparationStatus = {
	status: "preparing" | "ready" | "error" | "canceled" | "closed";
	sessionId?: string;
};

function isPreparation(value: unknown): value is Preparation {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"status" in value &&
		value.status === "preparing"
	);
}

function isPreparationStatus(value: unknown): value is PreparationStatus {
	return (
		typeof value === "object" &&
		value !== null &&
		"status" in value &&
		["preparing", "ready", "error", "canceled", "closed"].includes(
			String(value.status),
		)
	);
}

function waitForPoll(signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Editor preparation was canceled"));
			return;
		}
		const timer = window.setTimeout(() => {
			signal.removeEventListener("abort", canceled);
			resolve();
		}, 500);
		const canceled = () => {
			window.clearTimeout(timer);
			reject(new Error("Editor preparation was canceled"));
		};
		signal.addEventListener("abort", canceled, { once: true });
	});
}

export function StudioEditorClient(props: {
	videoId: string;
	userId: string;
	captionsEnabled: boolean;
	savedAt: string | null;
	preparingTitle: string;
	preparingDuration: number;
	preparingTracks: Array<"display" | "camera">;
}) {
	const {
		videoId,
		userId,
		captionsEnabled,
		savedAt,
		preparingTitle,
		preparingDuration,
		preparingTracks,
	} = props;
	const router = useRouter();
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [errorFrameReady, setErrorFrameReady] = useState(false);
	const [recoveryConflict, setRecoveryConflict] =
		useState<EditorLocalDraft | null>(null);
	const [restoringBrowserDraft, setRestoringBrowserDraft] = useState(false);
	const [videoImport, setVideoImport] = useState<
		WebEditorVideoImportProgress | WebEditorCapImportProgress | null
	>(null);
	const [recordClipOpen, setRecordClipOpen] = useState(false);
	const [upgradeOpen, setUpgradeOpen] = useState(false);
	const preparationRef = useRef<string | null>(null);
	const sessionRef = useRef<string | null>(null);
	const bridgeRef = useRef<EditorHostBridge | null>(null);
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const errorFrameRef = useRef<HTMLIFrameElement | null>(null);
	const frameConnectRef = useRef<{
		document: Document;
		sessionId: string;
	} | null>(null);
	const restoreInProgressRef = useRef(false);
	const savedAtRef = useRef(savedAt);
	const captureDraftRef = useRef<() => boolean>(() => true);
	const closedRef = useRef(false);
	const restartAfterImport = useCallback(async () => {
		const activeSession = sessionRef.current;
		if (activeSession) {
			const response = await fetch(
				`/api/editor/sessions/${encodeURIComponent(activeSession)}?videoId=${encodeURIComponent(videoId)}`,
				{ method: "DELETE", cache: "no-store" },
			);
			if (!response.ok && response.status !== 404) {
				throw new Error(
					"Imported clip was saved, but the editor could not restart",
				);
			}
			sessionRef.current = null;
		}
		window.location.reload();
	}, [videoId]);

	useEffect(() => {
		const controller = new AbortController();
		savedAtRef.current = savedAt;
		closedRef.current = false;
		setSessionId(null);
		setError(null);
		setRecoveryConflict(null);
		setRestoringBrowserDraft(false);
		restoreInProgressRef.current = false;
		setVideoImport(null);
		setRecordClipOpen(false);
		setUpgradeOpen(false);
		let lastCapturedConfig: string | null = null;
		let lastCapturedSavedAt: string | null = null;
		const captureDraft = () => {
			let serialized: string | null;
			try {
				const editorWindow = iframeRef.current?.contentWindow as
					| (Window & {
							capSolidEditor?: { unsavedProject?: () => string | null };
					  })
					| null;
				serialized = editorWindow?.capSolidEditor?.unsavedProject?.() ?? null;
			} catch {
				return false;
			}
			if (!serialized) return true;
			if (
				serialized === lastCapturedConfig &&
				savedAtRef.current === lastCapturedSavedAt
			)
				return true;
			const captured = captureEditorLocalDraft(
				window.localStorage,
				userId,
				videoId,
				savedAtRef.current,
				serialized,
			);
			if (captured) {
				lastCapturedConfig = serialized;
				lastCapturedSavedAt = savedAtRef.current;
			}
			return captured;
		};
		captureDraftRef.current = captureDraft;
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (captureDraft()) return;
			event.preventDefault();
			event.returnValue = "";
		};
		const close = () => {
			if (closedRef.current) return;
			captureDraft();
			closedRef.current = true;
			controller.abort();
			bridgeRef.current?.dispose();
			bridgeRef.current = null;
			const activeSession = sessionRef.current;
			const activePreparation = preparationRef.current;
			sessionRef.current = null;
			preparationRef.current = null;
			if (activeSession) {
				void fetch(
					`/api/editor/sessions/${encodeURIComponent(activeSession)}?videoId=${encodeURIComponent(videoId)}`,
					{ method: "DELETE", keepalive: true },
				);
			} else if (activePreparation) {
				void fetch(
					`/api/editor/preparations/${encodeURIComponent(activePreparation)}?videoId=${encodeURIComponent(videoId)}`,
					{ method: "DELETE", keepalive: true },
				);
			}
		};
		const prepare = async () => {
			try {
				const response = await fetch("/api/editor/preparations", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ videoId }),
				});
				if (!response.ok) throw new Error("Editor preparation could not start");
				const created: unknown = await response.json();
				if (!isPreparation(created)) {
					throw new Error("Editor preparation response was invalid");
				}
				preparationRef.current = created.id;
				if (controller.signal.aborted) {
					void fetch(
						`/api/editor/preparations/${encodeURIComponent(created.id)}?videoId=${encodeURIComponent(videoId)}`,
						{ method: "DELETE", keepalive: true },
					);
					preparationRef.current = null;
					return;
				}
				const deadline = Date.now() + 5 * 60 * 1000;
				while (!controller.signal.aborted && Date.now() < deadline) {
					const statusResponse = await fetch(
						`/api/editor/preparations/${encodeURIComponent(created.id)}?videoId=${encodeURIComponent(videoId)}`,
						{ signal: controller.signal },
					);
					if (!statusResponse.ok) {
						throw new Error("Editor preparation status is unavailable");
					}
					const status: unknown = await statusResponse.json();
					if (!isPreparationStatus(status)) {
						throw new Error("Editor preparation status was invalid");
					}
					if (status.status === "ready") {
						if (!status.sessionId) {
							throw new Error("Editor session was not returned");
						}
						if (controller.signal.aborted) {
							void fetch(
								`/api/editor/sessions/${encodeURIComponent(status.sessionId)}?videoId=${encodeURIComponent(videoId)}`,
								{ method: "DELETE", keepalive: true },
							);
							return;
						}
						sessionRef.current = status.sessionId;
						preparationRef.current = null;
						const draft = readEditorLocalDraft(
							window.localStorage,
							userId,
							videoId,
						);
						if (draft) {
							if (!captionsEnabled && hasEditorCaptionContent(draft.config)) {
								setRecoveryConflict(draft);
								setError(
									"Browser edits include captions, which require Cap Pro. Restore your other edits without captions, or open the latest saved version.",
								);
								return;
							}
							const recovered = await fetch(
								`/api/editor/sessions/${encodeURIComponent(status.sessionId)}/config`,
								{
									method: "PUT",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({
										videoId,
										config: draft.config,
										expectedSavedAt: draft.baseSavedAt,
									}),
									signal: controller.signal,
								},
							);
							if (recovered.status === 409) {
								setRecoveryConflict(draft);
								setError(
									"This recording changed after the browser saved pending edits. Choose which version to open.",
								);
								return;
							}
							if (!recovered.ok)
								throw new Error(
									"Pending edits are saved in this browser, but the editor could not restore them. Try again.",
								);
							const result: unknown = await recovered.json();
							if (
								typeof result === "object" &&
								result !== null &&
								"savedAt" in result &&
								typeof result.savedAt === "string"
							) {
								savedAtRef.current = result.savedAt;
							}
							clearEditorLocalDraft(window.localStorage, userId, videoId);
						}
						if (controller.signal.aborted) return;
						setSessionId(status.sessionId);
						return;
					}
					if (status.status !== "preparing") {
						throw new Error("Editor preparation failed");
					}
					await waitForPoll(controller.signal);
				}
				throw new Error("Editor preparation timed out");
			} catch (cause) {
				if (!controller.signal.aborted) {
					setError(
						cause instanceof Error ? cause.message : "Editor is unavailable",
					);
				}
			}
		};
		const timer = window.setTimeout(() => void prepare(), 0);
		window.addEventListener("beforeunload", beforeUnload);
		window.addEventListener("popstate", captureDraft);
		window.addEventListener("pagehide", close);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener("beforeunload", beforeUnload);
			window.removeEventListener("popstate", captureDraft);
			window.removeEventListener("pagehide", close);
			close();
			captureDraftRef.current = () => true;
		};
	}, [captionsEnabled, savedAt, userId, videoId]);

	const restoreBrowserDraft = useCallback(async () => {
		const activeSession = sessionRef.current;
		const draft = recoveryConflict;
		if (!activeSession || !draft || restoreInProgressRef.current) return;
		const config =
			!captionsEnabled && hasEditorCaptionContent(draft.config)
				? stripEditorCaptionContent(draft.config)
				: draft.config;
		restoreInProgressRef.current = true;
		setRestoringBrowserDraft(true);
		try {
			const configUrl = `/api/editor/sessions/${encodeURIComponent(activeSession)}/config`;
			const revisionResponse = await fetch(
				`${configUrl}?videoId=${encodeURIComponent(videoId)}`,
				{ cache: "no-store" },
			).catch(() => null);
			const revision: unknown = await revisionResponse
				?.json()
				.catch(() => null);
			if (
				!revisionResponse?.ok ||
				typeof revision !== "object" ||
				revision === null ||
				!("savedAt" in revision) ||
				(revision.savedAt !== null && typeof revision.savedAt !== "string")
			) {
				setError("The latest saved edits could not be checked. Try again.");
				return;
			}
			if (closedRef.current || sessionRef.current !== activeSession) return;
			const response = await fetch(configUrl, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					videoId,
					config,
					expectedSavedAt: revision.savedAt,
				}),
			}).catch(() => null);
			if (response?.status === 409) {
				setError(
					"This recording changed again while restoring browser edits. Choose which version to open.",
				);
				return;
			}
			if (!response?.ok) {
				setError("Browser edits could not be restored. Try again.");
				return;
			}
			const saved: unknown = await response.json().catch(() => null);
			if (
				typeof saved !== "object" ||
				saved === null ||
				!("savedAt" in saved) ||
				typeof saved.savedAt !== "string"
			) {
				setError(
					"Browser edits were saved, but the result could not be checked. Try again.",
				);
				return;
			}
			if (closedRef.current || sessionRef.current !== activeSession) return;
			savedAtRef.current = saved.savedAt;
			clearEditorLocalDraft(window.localStorage, userId, videoId);
			setRecoveryConflict(null);
			setError(null);
			setSessionId(activeSession);
		} finally {
			restoreInProgressRef.current = false;
			setRestoringBrowserDraft(false);
		}
	}, [captionsEnabled, recoveryConflict, userId, videoId]);

	const sendErrorToFrame = useCallback(
		(iframe: HTMLIFrameElement) => {
			const document = iframe.contentDocument;
			if (
				!error ||
				!document ||
				document.readyState !== "complete" ||
				new URL(document.URL).pathname !== "/editor-solid/index.html"
			)
				return;
			iframe.contentWindow?.postMessage(
				{
					kind: "cap-editor-error",
					version: 1,
					message: error,
					hasBrowserDraftConflict: recoveryConflict !== null,
					restoringBrowserDraft,
				},
				window.location.origin,
			);
		},
		[error, recoveryConflict, restoringBrowserDraft],
	);

	useEffect(() => {
		if (!error) {
			setErrorFrameReady(false);
			return;
		}
		bridgeRef.current?.dispose();
		bridgeRef.current = null;
		frameConnectRef.current = null;
	}, [error]);

	useEffect(() => {
		if (errorFrameRef.current) sendErrorToFrame(errorFrameRef.current);
	}, [sendErrorToFrame]);

	useEffect(() => {
		if (!error) return;
		const onErrorFrameMessage = (event: MessageEvent<unknown>) => {
			if (
				event.origin !== window.location.origin ||
				event.source !== errorFrameRef.current?.contentWindow ||
				typeof event.data !== "object" ||
				event.data === null
			)
				return;
			const message = event.data as Record<string, unknown>;
			if (message.version !== 1) return;
			if (message.kind === "cap-editor-error-ready") {
				setErrorFrameReady(true);
				return;
			}
			if (message.kind !== "cap-editor-error-action") return;
			if (message.action === "retry") {
				window.location.reload();
			} else if (message.action === "back-to-recording") {
				router.push(`/s/${encodeURIComponent(videoId)}`);
			} else if (
				message.action === "restore-browser" &&
				recoveryConflict &&
				!restoringBrowserDraft
			) {
				void restoreBrowserDraft();
			} else if (
				message.action === "open-latest" &&
				recoveryConflict &&
				!restoringBrowserDraft
			) {
				clearEditorLocalDraft(window.localStorage, userId, videoId);
				window.location.reload();
			}
		};
		window.addEventListener("message", onErrorFrameMessage);
		return () => window.removeEventListener("message", onErrorFrameMessage);
	}, [
		error,
		recoveryConflict,
		restoringBrowserDraft,
		restoreBrowserDraft,
		router,
		userId,
		videoId,
	]);

	const onFrameLoad = useCallback(
		(iframe: HTMLIFrameElement) => {
			const document = iframe.contentDocument;
			if (
				!document ||
				document.readyState !== "complete" ||
				new URL(document.URL).pathname !== "/editor-solid/index.html" ||
				closedRef.current
			)
				return;
			iframe.contentWindow?.postMessage(
				{
					kind: "cap-editor-preparing",
					version: 1,
					title: preparingTitle,
					durationSeconds: preparingDuration,
					tracks: preparingTracks,
				},
				window.location.origin,
			);
			if (!sessionId) return;
			const previous = frameConnectRef.current;
			if (previous?.document === document) {
				if (previous.sessionId === sessionId) return;
				frameConnectRef.current = null;
				iframe.src = "/editor-solid/index.html";
				return;
			}
			frameConnectRef.current = { document, sessionId };
			bridgeRef.current?.dispose();
			const bridge = new EditorHostBridge(
				videoId,
				sessionId,
				userId,
				(reason) =>
					router.push(
						reason === "deleted"
							? "/dashboard/caps"
							: `/s/${encodeURIComponent(videoId)}`,
					),
				(cause) => {
					captureDraftRef.current();
					setError(cause.message);
				},
				(progress) => setVideoImport(progress),
				() => setRecordClipOpen(true),
				restartAfterImport,
				captionsEnabled,
				() => setUpgradeOpen(true),
				(nextSavedAt) => {
					savedAtRef.current = nextSavedAt;
				},
				() => savedAtRef.current,
			);
			bridgeRef.current = bridge;
			void bridge.connect(iframe).catch((cause) => {
				bridge.dispose();
				if (bridgeRef.current === bridge) {
					captureDraftRef.current();
					setError(
						cause instanceof Error ? cause.message : "Editor could not connect",
					);
				}
			});
		},
		[
			captionsEnabled,
			preparingDuration,
			preparingTitle,
			preparingTracks,
			restartAfterImport,
			router,
			sessionId,
			userId,
			videoId,
		],
	);

	useEffect(() => {
		if (sessionId && iframeRef.current) onFrameLoad(iframeRef.current);
	}, [onFrameLoad, sessionId]);

	if (error) {
		return (
			<div className="relative h-screen w-screen bg-[#f1f1f3]">
				<iframe
					ref={errorFrameRef}
					title="Cap editor error"
					src="/editor-solid/index.html"
					className={
						errorFrameReady
							? "h-full w-full border-0"
							: "pointer-events-none absolute inset-0 h-full w-full border-0 opacity-0"
					}
					onLoad={(event) => sendErrorToFrame(event.currentTarget)}
				/>
				{!errorFrameReady && (
					<div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-neutral-900">
						<p role="alert">{error}</p>
						{recoveryConflict ? (
							<div className="flex gap-3">
								<button
									type="button"
									className="rounded-md bg-neutral-900 px-4 py-2 text-white"
									disabled={restoringBrowserDraft}
									onClick={() => void restoreBrowserDraft()}
								>
									{restoringBrowserDraft
										? "Restoring browser edits…"
										: "Restore browser edits"}
								</button>
								<button
									type="button"
									className="rounded-md border border-neutral-300 px-4 py-2"
									disabled={restoringBrowserDraft}
									onClick={() => {
										clearEditorLocalDraft(window.localStorage, userId, videoId);
										window.location.reload();
									}}
								>
									Open latest saved
								</button>
							</div>
						) : (
							<button
								type="button"
								className="rounded-md bg-neutral-900 px-4 py-2 text-white"
								onClick={() => window.location.reload()}
							>
								Try again
							</button>
						)}
					</div>
				)}
			</div>
		);
	}
	return (
		<div className="relative h-screen w-screen">
			<iframe
				ref={iframeRef}
				title="Cap editor"
				src="/editor-solid/index.html"
				className="h-full w-full border-0"
				onLoad={(event) => onFrameLoad(event.currentTarget)}
			/>
			{recordClipOpen && (
				<EditorClipRecorder
					onCaptured={async (clip: EditorClipCapture) => {
						const bridge = bridgeRef.current;
						if (!bridge || closedRef.current)
							throw new Error("Editor session is unavailable");
						await bridge.addRecordedClip(
							clip.display,
							clip.camera,
							clip.cameraOffsetMs,
						);
					}}
					onClose={(imported) => {
						setRecordClipOpen(false);
						if (imported) {
							void restartAfterImport().catch((cause) => {
								captureDraftRef.current();
								setError(
									cause instanceof Error
										? cause.message
										: "Editor could not restart",
								);
							});
						}
					}}
				/>
			)}
			{upgradeOpen && (
				<UpgradeModal open={upgradeOpen} onOpenChange={setUpgradeOpen} />
			)}
			{videoImport && videoImport.stage !== "ready" && (
				<output className="pointer-events-none absolute bottom-6 right-6 z-50 w-64 rounded-xl border border-white/10 bg-neutral-950/95 px-4 py-3 text-sm text-white shadow-xl">
					{videoImport.stage === "uploading" ? (
						<>
							<p>
								Uploading {"kind" in videoImport ? "Cap recording" : "video"}{" "}
								{Math.round(videoImport.fraction * 100)}%
							</p>
							<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/20">
								<div
									className="h-full rounded-full bg-blue-400 transition-[width] duration-150"
									style={{ width: `${videoImport.fraction * 100}%` }}
								/>
							</div>
						</>
					) : (
						<p>
							{videoImport.stage === "importing"
								? "Importing Cap recording…"
								: "Preparing video…"}
						</p>
					)}
				</output>
			)}
		</div>
	);
}
