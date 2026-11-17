"use client";

import { DropdownMenuItem, DropdownMenuSeparator } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { type CapAction, capActionLabel } from "./cap-action-label";

type ActionResult =
	| { type: "toast"; message: string }
	| { type: "open"; url: string; message?: string };

const actionsPath = (videoId: string) =>
	`/api/app-store/caps/${encodeURIComponent(videoId)}/actions`;

async function readError(response: Response) {
	const body = (await response.json().catch(() => null)) as {
		error?: string;
	} | null;
	return body?.error ?? "Something went wrong";
}

export function CapAppActionItems({ videoId }: { videoId: Video.VideoId }) {
	const [data, setData] = useState<CapAction[] | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		fetch(actionsPath(videoId), {
			credentials: "same-origin",
			signal: controller.signal,
		})
			.then((response) => (response.ok ? response.json() : null))
			.then((body: { actions?: CapAction[] } | null) =>
				setData(body?.actions ?? []),
			)
			.catch(() => {});
		return () => controller.abort();
	}, [videoId]);

	if (!data || data.length === 0) return null;

	const run = (action: CapAction) => {
		const toastId = toast.loading(`${action.title}...`);
		fetch(actionsPath(videoId), {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				installationId: action.installationId,
				actionId: action.actionId,
			}),
		})
			.then(async (response) => {
				if (!response.ok) throw new Error(await readError(response));
				const { result } = (await response.json()) as {
					result: ActionResult;
				};
				const message = result.message ?? `${action.title}: done`;
				if (result.type === "open" && result.url.startsWith("https://")) {
					const url = result.url;
					const open = () => window.open(url, "_blank", "noopener,noreferrer");
					// The browser can block a tab opened this long after the
					// click, so the link also stays one click away in the toast.
					open();
					toast.success(message, {
						id: toastId,
						action: { label: "Open", onClick: open },
					});
					return;
				}
				toast.success(message, { id: toastId });
			})
			.catch((error: unknown) => {
				toast.error(
					error instanceof Error ? error.message : "Something went wrong",
					{ id: toastId },
				);
			});
	};

	return (
		<>
			<DropdownMenuSeparator />
			<div className="max-h-[40vh] overflow-y-auto">
				{data.map((action) => (
					<DropdownMenuItem
						key={`${action.installationId}:${action.actionId}`}
						onClick={(event) => {
							event.stopPropagation();
							run(action);
						}}
						className="flex gap-2 items-center rounded-lg"
					>
						<img
							src={action.iconUrl}
							alt=""
							width={14}
							height={14}
							className="size-3.5 rounded-[3px]"
						/>
						<p className="text-sm text-gray-12">
							{capActionLabel(action, data)}
						</p>
					</DropdownMenuItem>
				))}
			</div>
		</>
	);
}
