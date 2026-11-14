"use client";

import { DropdownMenuItem, DropdownMenuSeparator } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type CapAction = {
	installationId: string;
	appName: string;
	iconUrl: string;
	actionId: string;
	title: string;
};

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
		const promise = fetch(actionsPath(videoId), {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				installationId: action.installationId,
				actionId: action.actionId,
			}),
		}).then(async (response) => {
			if (!response.ok) throw new Error(await readError(response));
			const { result } = (await response.json()) as { result: ActionResult };
			if (result.type === "open" && result.url.startsWith("https://")) {
				window.open(result.url, "_blank", "noopener,noreferrer");
			}
			return result.message ?? `${action.title}: done`;
		});
		toast.promise(promise, {
			loading: `${action.title}...`,
			success: (message) => message,
			error: (error) =>
				error instanceof Error ? error.message : "Something went wrong",
		});
	};

	return (
		<>
			<DropdownMenuSeparator />
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
					<p className="text-sm text-gray-12">{action.title}</p>
				</DropdownMenuItem>
			))}
		</>
	);
}
