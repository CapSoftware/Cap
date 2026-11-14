"use client";

import { DropdownMenuItem, DropdownMenuSeparator } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { listCapActionsAction, runCapActionAction } from "@/actions/app-store";

export function CapAppActionItems({ videoId }: { videoId: Video.VideoId }) {
	const { data } = useQuery({
		queryKey: ["app-store", "cap-actions", videoId],
		queryFn: async () => {
			const result = await listCapActionsAction(videoId);
			return result.ok ? result.value : [];
		},
		staleTime: 60_000,
	});

	if (!data || data.length === 0) return null;

	const run = (action: (typeof data)[number]) => {
		const promise = runCapActionAction({
			videoId,
			installationId: action.installationId,
			actionId: action.actionId,
		}).then((result) => {
			if (!result.ok) throw new Error(result.error);
			if (result.value.type === "open") {
				window.open(result.value.url, "_blank", "noopener,noreferrer");
			}
			return result.value.message ?? `${action.title}: done`;
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
