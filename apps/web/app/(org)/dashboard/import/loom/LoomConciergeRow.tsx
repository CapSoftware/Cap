"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
} from "@cap/ui";
import type { Organisation } from "@cap/web-domain";
import { faPeopleCarryBox } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";
import {
	answerLoomMigrationQuestion,
	confirmLoomMigrationInvite,
	getLoomMigrationDashboard,
	requestLoomMigration,
} from "@/actions/loom-concierge";
import type { LoomMigrationView } from "@/lib/loom-concierge";
import { unwrapLoomMigrationResult } from "@/lib/loom-migration-state";

const textareaClassName =
	"w-full min-h-20 px-4 py-3 rounded-xl border text-[16px] md:text-[13px] text-gray-12 bg-gray-1 border-gray-4 outline-0 transition-all duration-200 hover:bg-gray-2 hover:border-gray-5 focus:bg-gray-2 focus:border-gray-5 placeholder:text-gray-8";

function statusCopy(request: LoomMigrationView) {
	if (request.status === "completed") {
		const finished = request.completedAt
			? new Date(request.completedAt).toLocaleDateString()
			: null;
		return {
			title: "Loom migration complete",
			body: `${request.importedVideoCount} ${request.importedVideoCount === 1 ? "video" : "videos"} moved${finished ? ` on ${finished}` : ""}.`,
		};
	}
	if (request.status === "needs_information") {
		return {
			title: "We need a little more information",
			body: "Reply below so we can keep moving your videos.",
		};
	}
	if (request.status === "in_progress") {
		return {
			title: "Moving your Loom videos",
			body: "We'll email you when everything has been checked.",
		};
	}
	if (!request.invitedAt) {
		return {
			title: "Loom migration requested",
			body: "Next, invite hello@cap.so to your Loom workspace with download permission.",
		};
	}
	return {
		title: "Loom migration requested",
		body: "We'll review your workspace and email you with next steps.",
	};
}

export function LoomConciergeRow({
	organizationId,
}: {
	organizationId: Organisation.OrganisationId;
}) {
	const queryClient = useQueryClient();
	const [dialogOpen, setDialogOpen] = useState(false);
	const [workspaceName, setWorkspaceName] = useState("");
	const [note, setNote] = useState("");
	const [answer, setAnswer] = useState("");
	const workspaceNameId = useId();
	const noteId = useId();
	const answerId = useId();

	const queryKey = ["loom-concierge", organizationId];
	const migrationQuery = useQuery({
		queryKey,
		queryFn: () => getLoomMigrationDashboard(organizationId),
		refetchInterval: 60_000,
	});
	const refresh = () => queryClient.invalidateQueries({ queryKey });

	const requestMutation = useMutation({
		mutationFn: async () =>
			unwrapLoomMigrationResult(
				await requestLoomMigration({ organizationId, workspaceName, note }),
			),
		onSuccess: async () => {
			await refresh();
			setDialogOpen(false);
			setWorkspaceName("");
			setNote("");
			toast.success("Migration requested");
		},
		onError: (error) => toast.error(error.message),
	});
	const inviteMutation = useMutation({
		mutationFn: async (requestId: string) =>
			unwrapLoomMigrationResult(await confirmLoomMigrationInvite(requestId)),
		onSuccess: async () => {
			await refresh();
			toast.success("Thanks, we'll take it from here");
		},
		onError: (error) => toast.error(error.message),
	});
	const answerMutation = useMutation({
		mutationFn: async (input: { requestId: string; answer: string }) =>
			unwrapLoomMigrationResult(await answerLoomMigrationQuestion(input)),
		onSuccess: async () => {
			setAnswer("");
			await refresh();
			toast.success("Reply sent");
		},
		onError: (error) => toast.error(error.message),
	});

	if (!migrationQuery.data?.isPro) return null;

	const requests = migrationQuery.data.requests;
	const request =
		requests.find((item) => item.status !== "completed") ?? requests[0];
	const copy = request
		? statusCopy(request)
		: {
				title: "Moving a whole Loom workspace?",
				body: "We'll move it for you, keeping owners and spaces. Included with Cap Pro.",
			};

	return (
		<>
			<div className="flex flex-col gap-4 p-5 rounded-xl border bg-gray-2 border-gray-3">
				<div className="flex flex-col gap-4 justify-between sm:flex-row sm:items-center">
					<div className="flex gap-4 items-start sm:items-center">
						<div className="flex flex-shrink-0 justify-center items-center rounded-lg size-10 bg-gray-3 text-gray-11">
							<FontAwesomeIcon className="size-4" icon={faPeopleCarryBox} />
						</div>
						<div className="flex flex-col gap-1.5">
							<p className="text-sm font-medium text-gray-12">{copy.title}</p>
							<p className="text-xs text-gray-10">{copy.body}</p>
						</div>
					</div>
					{(!request || request.status === "completed") && (
						<Button
							type="button"
							variant="white"
							size="sm"
							className="flex-shrink-0"
							onClick={() => setDialogOpen(true)}
						>
							{request ? "Request another" : "Request migration"}
						</Button>
					)}
					{request?.status === "pending" && !request.invitedAt && (
						<Button
							type="button"
							variant="white"
							size="sm"
							className="flex-shrink-0"
							spinner={inviteMutation.isPending}
							disabled={inviteMutation.isPending}
							onClick={() => inviteMutation.mutate(request.id)}
						>
							I've sent the invite
						</Button>
					)}
				</div>

				{request?.status === "needs_information" && (
					<form
						className="flex flex-col gap-3 sm:pl-14"
						onSubmit={(event) => {
							event.preventDefault();
							answerMutation.mutate({ requestId: request.id, answer });
						}}
					>
						{request.capMessage && (
							<p className="text-sm whitespace-pre-wrap text-gray-12">
								{request.capMessage}
							</p>
						)}
						<label htmlFor={answerId} className="sr-only">
							Your reply
						</label>
						<textarea
							id={answerId}
							className={textareaClassName}
							maxLength={2000}
							placeholder="Your reply"
							value={answer}
							onChange={(event) => setAnswer(event.target.value)}
						/>
						<Button
							type="submit"
							variant="dark"
							size="sm"
							className="self-end"
							spinner={answerMutation.isPending}
							disabled={answerMutation.isPending || !answer.trim()}
						>
							Send reply
						</Button>
					</form>
				)}
			</div>

			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent className="w-[calc(100%-20px)] max-w-md">
					<DialogHeader
						icon={
							<FontAwesomeIcon icon={faPeopleCarryBox} className="size-3.5" />
						}
					>
						<DialogTitle>Request Loom migration</DialogTitle>
					</DialogHeader>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							requestMutation.mutate();
						}}
					>
						<div className="flex flex-col gap-4 p-5">
							<p className="text-sm text-gray-11">
								We'll move your Loom videos into this organization. After you
								request, invite hello@cap.so to your Loom workspace with
								download permission.
							</p>
							<div className="flex flex-col gap-2">
								<label
									htmlFor={workspaceNameId}
									className="text-sm font-medium text-gray-12"
								>
									Loom workspace name
								</label>
								<Input
									id={workspaceNameId}
									maxLength={255}
									placeholder="Optional"
									value={workspaceName}
									onChange={(event) => setWorkspaceName(event.target.value)}
								/>
							</div>
							<div className="flex flex-col gap-2">
								<label
									htmlFor={noteId}
									className="text-sm font-medium text-gray-12"
								>
									Notes
								</label>
								<textarea
									id={noteId}
									className={textareaClassName}
									maxLength={2000}
									placeholder="Roughly how many videos, which spaces matter most"
									value={note}
									onChange={(event) => setNote(event.target.value)}
								/>
							</div>
						</div>
						<DialogFooter>
							<Button
								type="button"
								size="sm"
								variant="gray"
								onClick={() => setDialogOpen(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								size="sm"
								variant="dark"
								spinner={requestMutation.isPending}
								disabled={requestMutation.isPending}
							>
								Request migration
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
