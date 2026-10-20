"use client";

import { Button, Card, CardHeader, CardTitle, Input } from "@cap/ui";
import { useId, useRef, useState, useTransition } from "react";
import {
	getRecordingOwnershipTransfer,
	prepareRecordingOwnershipPreflight,
	previewRecordingOwnershipTransfer,
	retryRecordingOwnershipTransfer,
	rollbackRecordingOwnershipTransfer,
	startRecordingOwnershipTransfer,
} from "@/actions/organization/recording-ownership-transfer";

type Preview = Awaited<ReturnType<typeof previewRecordingOwnershipTransfer>>;
type Status = Awaited<ReturnType<typeof getRecordingOwnershipTransfer>>;

export function RecordingOwnership() {
	const fieldId = useId();
	const [videoId, setVideoId] = useState("");
	const [targetUserId, setTargetUserId] = useState("");
	const [destinationFolderId, setDestinationFolderId] = useState("");
	const [receipt, setReceipt] = useState<string>();
	const [preview, setPreview] = useState<Preview>();
	const [operationId, setOperationId] = useState("");
	const [status, setStatus] = useState<Status>();
	const [rollbackReady, setRollbackReady] = useState(false);
	const [confirmed, setConfirmed] = useState(false);
	const [message, setMessage] = useState("");
	const [pending, startTransition] = useTransition();
	const busy = useRef(false);
	const startRequest = useRef<
		Parameters<typeof startRecordingOwnershipTransfer>[0] | undefined
	>(undefined);
	const request = {
		videoId,
		targetUserId,
		destinationFolderId: destinationFolderId || null,
	};
	const valid = [videoId, targetUserId].every((value) =>
		/^[a-zA-Z0-9_-]{1,15}$/.test(value),
	);

	function run(action: () => Promise<void>) {
		if (busy.current) return;
		busy.current = true;
		setMessage("");
		startTransition(async () => {
			try {
				await action();
			} catch {
				setMessage(
					"Request held. Check access and current state before retrying.",
				);
			} finally {
				busy.current = false;
			}
		});
	}

	function changed() {
		setReceipt(undefined);
		setPreview(undefined);
		setConfirmed(false);
		setMessage("");
	}

	async function refresh() {
		setStatus(await getRecordingOwnershipTransfer(operationId));
		setRollbackReady(false);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Transfer recording ownership</CardTitle>
			</CardHeader>
			<div className="flex flex-col gap-4 p-6">
				<p className="text-sm text-gray-11">
					Transfer one completed recording within the active organization.
					Sharing, source folders, other recordings, and original media are
					preserved. Processing is not restarted.
				</p>
				<fieldset
					disabled={pending || Boolean(startRequest.current)}
					className="flex flex-col gap-3"
				>
					<label htmlFor={`${fieldId}-video`}>Recording ID</label>
					<Input
						id={`${fieldId}-video`}
						autoComplete="off"
						maxLength={15}
						value={videoId}
						onChange={(event) => {
							changed();
							setVideoId(event.target.value);
						}}
					/>
					<label htmlFor={`${fieldId}-target`}>Destination member ID</label>
					<Input
						id={`${fieldId}-target`}
						autoComplete="off"
						maxLength={15}
						value={targetUserId}
						onChange={(event) => {
							changed();
							setTargetUserId(event.target.value);
						}}
					/>
					<label htmlFor={`${fieldId}-folder`}>
						Destination folder ID (optional)
					</label>
					<Input
						id={`${fieldId}-folder`}
						autoComplete="off"
						maxLength={15}
						value={destinationFolderId}
						onChange={(event) => {
							changed();
							setDestinationFolderId(event.target.value);
						}}
					/>
					<p className="text-sm text-gray-11">
						Leave the folder blank for the member’s root. Public personal
						collections must keep their current folder.
					</p>
					<Button
						type="button"
						disabled={!valid}
						onClick={() =>
							run(async () => {
								const challenge =
									await prepareRecordingOwnershipPreflight(request);
								const url = URL.createObjectURL(
									new Blob([challenge.request], {
										type: "application/octet-stream",
									}),
								);
								const link = document.createElement("a");
								link.href = url;
								link.download = "recording-ownership-request.txt";
								link.click();
								setTimeout(() => URL.revokeObjectURL(url), 1000);
								setMessage(
									"Challenge downloaded. Keep it private and give it only to your authorized operator.",
								);
							})
						}
					>
						Download preflight challenge
					</Button>
					<label htmlFor={`${fieldId}-receipt`}>
						Operator receipt (if required)
					</label>
					<input
						key={`${videoId}:${targetUserId}:${destinationFolderId}`}
						id={`${fieldId}-receipt`}
						type="file"
						onChange={(event) => {
							const file = event.target.files?.[0];
							setReceipt(undefined);
							setPreview(undefined);
							setConfirmed(false);
							if (!file) return;
							run(async () => {
								if (file.size > 8 * 1024 ** 2)
									throw new Error("Receipt too large");
								setReceipt(await file.text());
								setMessage("Receipt loaded in this page.");
							});
						}}
					/>
					<Button
						type="button"
						disabled={!valid}
						onClick={() =>
							run(async () => {
								setPreview(undefined);
								setConfirmed(false);
								setPreview(
									await previewRecordingOwnershipTransfer({
										...request,
										preflightReceipt: receipt,
									}),
								);
							})
						}
					>
						Check transfer (read only)
					</Button>
					{preview && (
						<output>
							{preview.ready
								? "Transfer is ready for review."
								: `Transfer held: ${preview.reason}`}
						</output>
					)}
					<label className="flex gap-2">
						<input
							type="checkbox"
							checked={confirmed}
							onChange={(event) => setConfirmed(event.target.checked)}
						/>
						I have verified the recording, destination member, and folder.
					</label>
				</fieldset>
				<Button
					type="button"
					disabled={pending || !preview?.ready || !confirmed}
					onClick={() =>
						run(async () => {
							if (!preview?.ready) return;
							startRequest.current ??= {
								...request,
								preflightReceipt: receipt,
								previewToken: preview.previewToken,
								requestId: crypto.randomUUID().replaceAll("-", "").slice(0, 15),
							};
							setOperationId(startRequest.current.requestId);
							setStatus(undefined);
							setRollbackReady(false);
							const result = await startRecordingOwnershipTransfer(
								startRequest.current,
							);
							setOperationId(result.operationId);
							setStatus(
								await getRecordingOwnershipTransfer(result.operationId),
							);
						})
					}
				>
					Start or recover transfer
				</Button>
				<p className="text-sm text-gray-11">
					Save the operation ID before leaving this page. After an uncertain
					response, check this operation or retry it; do not create another
					transfer.
				</p>
				<label htmlFor={`${fieldId}-operation`}>Operation ID</label>
				<Input
					id={`${fieldId}-operation`}
					autoComplete="off"
					maxLength={15}
					disabled={pending || Boolean(startRequest.current)}
					value={operationId}
					onChange={(event) => {
						setOperationId(event.target.value);
						setStatus(undefined);
						setRollbackReady(false);
					}}
				/>
				{status && (
					<output>
						{status.state}: {status.phase}
						{status.errorCode ? ` (${status.errorCode})` : ""}
					</output>
				)}
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						disabled={pending || !operationId}
						onClick={() => run(refresh)}
					>
						Refresh status
					</Button>
					<Button
						type="button"
						disabled={pending || status?.phase !== "copying"}
						onClick={() =>
							run(async () => {
								await retryRecordingOwnershipTransfer(operationId);
								await refresh();
							})
						}
					>
						Retry same operation
					</Button>
					<Button
						type="button"
						disabled={pending || !operationId}
						onClick={() =>
							run(async () => {
								setRollbackReady(false);
								const result = await rollbackRecordingOwnershipTransfer({
									operationId,
									dryRun: true,
								});
								setRollbackReady(result.phase === "ready");
								setMessage(
									result.phase === "ready"
										? "Cancellation or rollback is ready for review."
										: "Operation already cancelled or rolled back.",
								);
							})
						}
					>
						Check cancellation or rollback
					</Button>
					<Button
						type="button"
						disabled={pending || !rollbackReady}
						onClick={() =>
							run(async () => {
								setRollbackReady(false);
								await rollbackRecordingOwnershipTransfer({
									operationId,
									dryRun: false,
								});
								await refresh();
							})
						}
					>
						Confirm cancellation or rollback
					</Button>
				</div>
				<p className="text-sm text-gray-11">
					Rollback restores ownership and references only when the snapshot and
					media still match. Originals and copied media remain in storage.
				</p>
				<output>{message}</output>
			</div>
		</Card>
	);
}
