import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectConfiguration } from "../types/project-config";
import { normalizeProjectForSave } from "../utils/normalize-config";

type RenderStatus = "IDLE" | "QUEUED" | "PROCESSING" | "COMPLETE" | "ERROR";

interface SaveState {
	status: RenderStatus;
	progress: number;
	message: string | null;
	error: string | null;
}

const IDLE_STATE: SaveState = {
	status: "IDLE",
	progress: 0,
	message: null,
	error: null,
};

const POLL_INTERVAL_MS = 3000;
const STALL_THRESHOLD_MS = 60_000;

export interface SaveRender {
	saveState: SaveState;
	isSaving: boolean;
	isSubmitting: boolean;
	hasSavedRender: boolean;
	canRetry: boolean;
	save: (config: ProjectConfiguration, force?: boolean) => void;
	cancel: () => void;
}

export function useSaveRender(videoId: string): SaveRender {
	const [saveState, setSaveState] = useState<SaveState>(IDLE_STATE);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [hasSavedRender, setHasSavedRender] = useState(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const wasCancelledRef = useRef(false);
	const processingStartRef = useRef<number | null>(null);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const stopPolling = useCallback(() => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
		processingStartRef.current = null;
	}, []);

	const fetchStatus = useCallback(async () => {
		try {
			const response = await fetch(`/api/editor/${videoId}/save`, {
				method: "GET",
				cache: "no-store",
			});

			if (!response.ok) return;

			const data = (await response.json()) as {
				status?: RenderStatus;
				renderState?: {
					progress?: number;
					message?: string | null;
					error?: string | null;
				} | null;
			};

			if (!mountedRef.current) return;

			const status = data.status ?? "IDLE";
			const renderState = data.renderState;

			if (status === "PROCESSING" && processingStartRef.current === null) {
				processingStartRef.current = Date.now();
			}

			if (status === "COMPLETE") {
				setHasSavedRender(true);
				stopPolling();
				setSaveState({
					status: "COMPLETE",
					progress: 100,
					message: renderState?.message ?? "Save complete",
					error: null,
				});
				setTimeout(() => {
					if (mountedRef.current) {
						setSaveState(IDLE_STATE);
					}
				}, 2000);
				return;
			}

			if (status === "ERROR") {
				stopPolling();
				setSaveState({
					status: "ERROR",
					progress: 0,
					message: renderState?.message ?? null,
					error: renderState?.error ?? "Save failed",
				});
				return;
			}

			if (status === "QUEUED" || status === "PROCESSING") {
				setSaveState({
					status,
					progress: renderState?.progress ?? 0,
					message: renderState?.message ?? null,
					error: null,
				});
				return;
			}

			setSaveState({
				status,
				progress: 0,
				message: null,
				error: null,
			});
		} catch {}
	}, [videoId, stopPolling]);

	const startPolling = useCallback(() => {
		stopPolling();
		pollRef.current = setInterval(fetchStatus, POLL_INTERVAL_MS);
	}, [fetchStatus, stopPolling]);

	useEffect(() => {
		fetchStatus();
		return stopPolling;
	}, [fetchStatus, stopPolling]);

	useEffect(() => {
		if (saveState.status === "QUEUED" || saveState.status === "PROCESSING") {
			if (!pollRef.current) {
				startPolling();
			}
		}
	}, [saveState.status, startPolling]);

	const isSaving =
		saveState.status === "QUEUED" || saveState.status === "PROCESSING";

	const isStalled =
		saveState.status === "PROCESSING" &&
		processingStartRef.current !== null &&
		Date.now() - processingStartRef.current > STALL_THRESHOLD_MS;

	const canRetry = saveState.status === "ERROR" || isStalled;

	const save = useCallback(
		(config: ProjectConfiguration, force?: boolean) => {
			const shouldForce = force || wasCancelledRef.current;
			wasCancelledRef.current = false;

			const configToSave = normalizeProjectForSave(config);
			setIsSubmitting(true);
			setSaveState({
				status: "QUEUED",
				progress: 0,
				message: "Starting save...",
				error: null,
			});

			fetch(`/api/editor/${videoId}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ config: configToSave, force: shouldForce }),
			})
				.then(async (response) => {
					if (!mountedRef.current) return;

					if (!response.ok) {
						const data = (await response.json().catch(() => ({}))) as {
							error?: string;
						};
						setSaveState({
							status: "ERROR",
							progress: 0,
							message: null,
							error: data.error || "Failed to save changes",
						});
						return;
					}

					const data = (await response.json()) as {
						status?: RenderStatus;
						renderState?: {
							progress?: number;
							message?: string | null;
							error?: string | null;
						} | null;
					};

					if (!mountedRef.current) return;

					const status = data.status ?? "QUEUED";
					processingStartRef.current = null;

					setSaveState({
						status,
						progress: data.renderState?.progress ?? 0,
						message: data.renderState?.message ?? null,
						error: data.renderState?.error ?? null,
					});

					if (status === "QUEUED" || status === "PROCESSING") {
						startPolling();
					}
				})
				.catch(() => {
					if (!mountedRef.current) return;
					setSaveState({
						status: "ERROR",
						progress: 0,
						message: null,
						error: "Failed to save",
					});
				})
				.finally(() => {
					if (mountedRef.current) {
						setIsSubmitting(false);
					}
				});
		},
		[videoId, startPolling],
	);

	const cancel = useCallback(() => {
		stopPolling();
		wasCancelledRef.current = true;
		setSaveState(IDLE_STATE);
	}, [stopPolling]);

	return {
		saveState,
		isSaving,
		isSubmitting,
		hasSavedRender,
		canRetry,
		save,
		cancel,
	};
}
