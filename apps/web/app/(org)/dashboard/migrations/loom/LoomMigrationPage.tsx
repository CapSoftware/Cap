"use client";

import { Button } from "@cap/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleHelp, Clock3, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { toast } from "sonner";
import {
	answerLoomMigrationQuestion,
	confirmLoomMigrationInvite,
	getLoomMigrationDashboard,
	requestLoomMigration,
} from "@/actions/loom-concierge";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import type { LoomMigrationView } from "@/lib/loom-concierge";
import {
	LOOM_MIGRATION_STATUS_LABELS,
	type LoomMigrationStatus,
} from "@/lib/loom-migration-state";

const STATUS_STYLE: Record<LoomMigrationStatus, string> = {
	pending: "bg-amber-3 text-amber-11",
	in_progress: "bg-blue-3 text-blue-11",
	needs_information: "bg-orange-3 text-orange-11",
	completed: "bg-green-3 text-green-11",
};

function MigrationStatus({ request }: { request: LoomMigrationView }) {
	return (
		<div className="rounded-xl border border-gray-4 bg-gray-1 p-5">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h2 className="text-lg font-medium text-gray-12">Your migration</h2>
					<p className="mt-1 text-sm text-gray-10">
						Requested on {new Date(request.createdAt).toLocaleDateString()}
						{request.workspaceName ? ` for ${request.workspaceName}` : ""}
					</p>
				</div>
				<span
					className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_STYLE[request.status]}`}
				>
					{LOOM_MIGRATION_STATUS_LABELS[request.status]}
				</span>
			</div>
			{request.status === "pending" && (
				<p className="mt-4 text-sm text-gray-11">
					Your request is in Cap’s queue. We’ll review your Loom workspace and
					confirm the migration plan.
				</p>
			)}
			{request.status === "in_progress" && (
				<p className="mt-4 text-sm text-gray-11">
					Cap is moving your videos. We’ll mark this complete after checking the
					imported library.
				</p>
			)}
			{request.status === "completed" && (
				<div className="mt-4 flex items-start gap-3 text-sm text-gray-11">
					<CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-11" />
					<div>
						<p>Your migration is complete.</p>
						{request.expectedVideoCount !== null && (
							<p className="mt-1">
								{request.importedVideoCount} of {request.expectedVideoCount}{" "}
								videos verified in Cap.
							</p>
						)}
						<Link
							className="mt-2 inline-block text-blue-11 underline"
							href="/dashboard/caps"
						>
							View your Caps
						</Link>
					</div>
				</div>
			)}
			{request.capMessage && (
				<div className="mt-4 rounded-lg bg-gray-3 p-4 text-sm text-gray-12">
					<p className="font-medium">Update from Cap</p>
					<p className="mt-1 whitespace-pre-wrap">{request.capMessage}</p>
				</div>
			)}
			{request.customerReply && (
				<p className="mt-3 text-xs text-gray-10">
					Your latest reply: {request.customerReply}
				</p>
			)}
		</div>
	);
}

export function LoomMigrationPage() {
	const { activeOrganization, user } = useDashboardContext();
	const organizationId = activeOrganization?.organization.id;
	const queryClient = useQueryClient();
	const [requestFormOpen, setRequestFormOpen] = useState(false);
	const [workspaceName, setWorkspaceName] = useState("");
	const [note, setNote] = useState("");
	const [answer, setAnswer] = useState("");
	const answerId = useId();
	const workspaceNameId = useId();
	const noteId = useId();

	const migrationQuery = useQuery({
		queryKey: ["loom-concierge", organizationId],
		queryFn: () => {
			if (!organizationId) throw new Error("Select a Cap workspace.");
			return getLoomMigrationDashboard(organizationId);
		},
		enabled: Boolean(organizationId),
		refetchInterval: 30_000,
	});

	const refresh = () =>
		queryClient.invalidateQueries({
			queryKey: ["loom-concierge", organizationId],
		});
	const requestMutation = useMutation({
		mutationFn: () => {
			if (!organizationId) throw new Error("Select a Cap workspace.");
			return requestLoomMigration({ organizationId, workspaceName, note });
		},
		onSuccess: async (result) => {
			await refresh();
			setRequestFormOpen(false);
			toast.success(
				result.alreadyRequested
					? "Your migration request is already in the queue."
					: "Migration requested. Invite hello@cap.so in Loom next.",
			);
		},
		onError: (error) => toast.error(error.message),
	});
	const inviteMutation = useMutation({
		mutationFn: confirmLoomMigrationInvite,
		onSuccess: async () => {
			await refresh();
			toast.success("Thanks. Cap can now review your Loom invite.");
		},
		onError: (error) => toast.error(error.message),
	});
	const answerMutation = useMutation({
		mutationFn: answerLoomMigrationQuestion,
		onSuccess: async () => {
			setAnswer("");
			await refresh();
			toast.success("Your answer has been sent to Cap.");
		},
		onError: (error) => toast.error(error.message),
	});

	const requests = migrationQuery.data?.requests ?? [];
	const activeRequest = requests.find(
		(request) => request.status !== "completed",
	);
	const completedRequest = requests.find(
		(request) => request.status === "completed",
	);
	const isPro = migrationQuery.data?.isPro ?? false;

	return (
		<div className="flex w-full max-w-5xl flex-col gap-6">
			<div>
				<p className="text-xs font-medium uppercase tracking-wide text-blue-11">
					Switch from Loom
				</p>
				<h1 className="mt-2 text-2xl font-medium text-gray-12">
					Move your Loom library to Cap
				</h1>
				<p className="mt-2 max-w-2xl text-sm text-gray-10">
					Import it yourself, or let Cap handle the move. Concierge migration is
					included with Cap Pro at no extra cost.
				</p>
			</div>

			{!organizationId && (
				<p className="rounded-lg border border-gray-4 bg-gray-1 p-4 text-sm text-gray-10">
					Select a Cap workspace to request a Loom migration.
				</p>
			)}
			{organizationId && migrationQuery.isPending && (
				<div className="flex items-center gap-2 text-sm text-gray-10">
					<LoaderCircle className="size-4 animate-spin" /> Loading your
					migration…
				</div>
			)}
			{migrationQuery.isError && (
				<div className="rounded-lg border border-red-7 bg-red-3 p-4 text-sm text-red-11">
					Could not load your migration. {migrationQuery.error.message}
					<button
						className="ml-2 underline"
						onClick={() => migrationQuery.refetch()}
						type="button"
					>
						Try again
					</button>
				</div>
			)}

			{activeRequest && <MigrationStatus request={activeRequest} />}
			{!activeRequest && completedRequest && (
				<MigrationStatus request={completedRequest} />
			)}

			{activeRequest && !activeRequest.invitedAt && (
				<div className="rounded-xl border border-blue-6 bg-blue-2 p-5">
					<div className="flex items-start gap-3">
						<Clock3 className="mt-0.5 size-5 shrink-0 text-blue-11" />
						<div>
							<h2 className="font-medium text-gray-12">
								One step left: invite Cap to Loom
							</h2>
							<p className="mt-2 text-sm text-gray-11">
								In your Loom workspace settings, invite{" "}
								<strong>hello@cap.so</strong> with video access and download
								permission. Some private Library videos need access shared
								separately. If we find any, we’ll ask you here. You can keep
								using Loom until we confirm the migration is complete.
							</p>
							<a
								className="mt-2 inline-block text-sm text-blue-11 underline"
								href="https://support.atlassian.com/loom/docs/add-remove-and-manage-members-in-your-workspace/"
								rel="noreferrer"
								target="_blank"
							>
								Loom’s workspace invite steps
							</a>
							<Button
								className="mt-4"
								disabled={inviteMutation.isPending}
								onClick={() => inviteMutation.mutate(activeRequest.id)}
								size="sm"
								variant="dark"
							>
								I sent the Loom invite
							</Button>
						</div>
					</div>
				</div>
			)}
			{activeRequest?.invitedAt && activeRequest.status !== "completed" && (
				<p className="text-sm text-gray-10">
					Loom invite marked as sent. Cap will take it from here.
				</p>
			)}
			{activeRequest?.status === "needs_information" && (
				<form
					className="rounded-xl border border-orange-6 bg-orange-2 p-5"
					onSubmit={(event) => {
						event.preventDefault();
						answerMutation.mutate({ requestId: activeRequest.id, answer });
					}}
				>
					<div className="flex items-center gap-2 font-medium text-gray-12">
						<CircleHelp className="size-5 text-orange-11" /> Cap needs a little
						more information
					</div>
					<label className="mt-4 block text-sm text-gray-11" htmlFor={answerId}>
						Your answer
					</label>
					<textarea
						className="mt-2 min-h-24 w-full rounded-lg border border-gray-6 bg-gray-1 p-3 text-sm text-gray-12"
						id={answerId}
						maxLength={2000}
						onChange={(event) => setAnswer(event.target.value)}
						value={answer}
					/>
					<Button
						disabled={answerMutation.isPending || !answer.trim()}
						size="sm"
						type="submit"
						variant="dark"
					>
						Send answer
					</Button>
				</form>
			)}

			<div className="grid gap-5 md:grid-cols-2">
				<div className="rounded-xl border border-gray-4 bg-gray-1 p-5">
					<h2 className="text-lg font-medium text-gray-12">Do it yourself</h2>
					<p className="mt-2 text-sm text-gray-10">
						Best when you already have a list of Loom links and video owners.
					</p>
					<ol className="mt-4 list-inside list-decimal space-y-2 text-sm text-gray-11">
						<li>
							Prepare a CSV with loom_video_url and user_email. space_name is
							optional.
						</li>
						<li>
							Upload up to 500 videos per CSV and review the owner mapping.
						</li>
						<li>
							Check the import results and your Cap library before leaving Loom.
						</li>
					</ol>
					{user.isPro ? (
						<Link
							className="mt-5 inline-block rounded-lg bg-gray-12 px-4 py-2 text-sm text-gray-1"
							href="/dashboard/import/loom?mode=csv"
						>
							Open CSV importer
						</Link>
					) : (
						<p className="mt-5 text-sm text-gray-10">
							The self-service importer requires your own Cap Pro account.
						</p>
					)}
				</div>
				<div className="rounded-xl border border-blue-6 bg-blue-2 p-5">
					<div className="flex items-center justify-between gap-2">
						<h2 className="text-lg font-medium text-gray-12">
							Cap handles it for you
						</h2>
						<span className="rounded-full bg-blue-4 px-2 py-1 text-xs text-blue-11">
							Free with Pro
						</span>
					</div>
					<p className="mt-2 text-sm text-gray-11">
						Request the migration and invite hello@cap.so to Loom. We’ll
						inventory, move, and verify your videos. No CSV preparation needed.
						If Loom restricts a video, we’ll ask for the specific access we
						need.
					</p>
					{!migrationQuery.isPending && !migrationQuery.isError && !isPro && (
						<div className="mt-5 text-sm text-gray-11">
							Your organization owner needs Cap Pro to request this service.
							<Link
								className="ml-1 text-blue-11 underline"
								href="/dashboard/settings/organization/billing"
							>
								View billing
							</Link>
						</div>
					)}
					{isPro && !activeRequest && !requestFormOpen && (
						<Button
							className="mt-5"
							onClick={() => setRequestFormOpen(true)}
							size="sm"
							variant="dark"
						>
							Enable concierge migration
						</Button>
					)}
					{isPro && !activeRequest && requestFormOpen && (
						<form
							className="mt-5 space-y-4"
							onSubmit={(event) => {
								event.preventDefault();
								requestMutation.mutate();
							}}
						>
							<div>
								<label
									className="text-sm text-gray-12"
									htmlFor={workspaceNameId}
								>
									Loom workspace name{" "}
									<span className="text-gray-10">(optional)</span>
								</label>
								<input
									className="mt-2 w-full rounded-lg border border-gray-6 bg-gray-1 px-3 py-2 text-sm text-gray-12"
									id={workspaceNameId}
									maxLength={255}
									onChange={(event) => setWorkspaceName(event.target.value)}
									value={workspaceName}
								/>
							</div>
							<div>
								<label className="text-sm text-gray-12" htmlFor={noteId}>
									Anything we should know?{" "}
									<span className="text-gray-10">(optional)</span>
								</label>
								<textarea
									className="mt-2 min-h-20 w-full rounded-lg border border-gray-6 bg-gray-1 p-3 text-sm text-gray-12"
									id={noteId}
									maxLength={2000}
									onChange={(event) => setNote(event.target.value)}
									value={note}
								/>
							</div>
							<Button
								disabled={requestMutation.isPending}
								size="sm"
								type="submit"
								variant="dark"
							>
								Request migration
							</Button>
						</form>
					)}
				</div>
			</div>
		</div>
	);
}
