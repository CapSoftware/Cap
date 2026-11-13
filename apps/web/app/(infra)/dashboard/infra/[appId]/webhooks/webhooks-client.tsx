"use client";

import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import {
	createInfraWebhook,
	deleteInfraWebhook,
	type InfraWebhookFailure,
	rotateInfraWebhookSecret,
	sendInfraWebhookTest,
	setInfraWebhookEnabled,
} from "@/actions/developers/webhooks";
import { infraWebhookLocks } from "@/lib/infra-webhook-console";
import { CopyTextButton, KeyRow } from "../../_components/copy";
import { ConfirmDialog } from "../../_components/dialog";
import {
	Button,
	FAINT,
	Input,
	MONO,
	MUTED,
	PANEL,
	PageHeader,
	Panel,
	Split,
	TEXT_LINK,
	Toggle,
} from "../../_components/ui";

export type InfraWebhookEndpoint = {
	id: string;
	url: string;
	events: string[];
	enabled: boolean;
	disabledByFailures: boolean;
	secretPrefix: string;
	lastDeliveryAt: Date | null;
	lastDeliveryStatus: "succeeded" | "failed" | null;
	lastResponseStatus: number | null;
	lastErrorCode: string | null;
	consecutiveFailures: number;
};

type Revealed = {
	endpointId: string;
	url: string;
	secret: string;
	rotated: boolean;
};

type TestOutcome = {
	delivered: boolean;
	responseStatus: number | null;
	errorCode: string | null;
	durationMs: number;
};

const deliveryFormat = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
	timeZone: "UTC",
});

const ERROR_TEXT: Record<string, string> = {
	timeout: "no answer within 10 seconds",
	connection_failed: "could not connect",
	redirect: "answered with a redirect, which is not followed",
	http_error: "answered with an error",
	private_address: "the host is not a public address",
	invalid_url: "the URL is not valid",
	https_required: "the URL is not https",
	credentials_in_url: "the URL holds a username or password",
	unsupported_port: "the URL uses a port other than 443",
};

const failureText = (status: number | null, errorCode: string | null) =>
	status !== null && (errorCode === null || errorCode === "http_error")
		? `HTTP ${status}`
		: (ERROR_TEXT[errorCode ?? ""] ?? "failed");

function lastDelivery(endpoint: InfraWebhookEndpoint) {
	if (!endpoint.lastDeliveryAt || !endpoint.lastDeliveryStatus) {
		return "No deliveries yet";
	}
	const when = `${deliveryFormat.format(new Date(endpoint.lastDeliveryAt))} UTC`;
	if (endpoint.lastDeliveryStatus === "succeeded") {
		return endpoint.lastResponseStatus === null
			? `Last delivery ${when}: delivered`
			: `Last delivery ${when}: HTTP ${endpoint.lastResponseStatus}`;
	}
	const streak =
		endpoint.consecutiveFailures > 1
			? `, ${endpoint.consecutiveFailures} failures in a row`
			: "";
	return `Last delivery ${when} failed: ${failureText(endpoint.lastResponseStatus, endpoint.lastErrorCode)}${streak}`;
}

function testText(test: TestOutcome) {
	const time = `${test.durationMs.toLocaleString("en-US")} ms`;
	return test.delivered
		? `Test delivered: HTTP ${test.responseStatus} in ${time}`
		: `Test failed: ${failureText(test.responseStatus, test.errorCode)} after ${time}`;
}

const isFailure = (result: {
	success: boolean;
}): result is InfraWebhookFailure => result.success === false;

type Problem = { message: string; hint: string | null };

const showRefusal = (failure: Problem) =>
	toast.error(
		failure.message,
		failure.hint ? { description: failure.hint } : {},
	);

export function WebhooksClient({
	appId,
	limit,
	eventTypes,
	endpoints,
}: {
	appId: string;
	limit: number;
	eventTypes: readonly string[];
	endpoints: InfraWebhookEndpoint[];
}) {
	const router = useRouter();
	const [adding, setAdding] = useState(false);
	const [creating, setCreating] = useState(false);
	const [revealed, setRevealed] = useState<Revealed | null>(null);
	const full = endpoints.length >= limit;
	const locks = infraWebhookLocks({
		adding,
		creating,
		secretShown: revealed !== null,
	});

	const startAdding = () => setAdding(true);

	return (
		<>
			<PageHeader
				title="Webhooks"
				description={
					<>
						Cap sends a signed POST to your server when a video is ready or
						fails.{" "}
						<Link href="/docs/api/webhooks" className={TEXT_LINK}>
							Verify the signature
						</Link>
						.
					</>
				}
				action={
					endpoints.length > 0 && locks.canAdd && !full ? (
						<Button onClick={startAdding}>Add endpoint</Button>
					) : undefined
				}
			/>

			{(revealed || adding) && (
				<div>
					{revealed && (
						<Split
							title={revealed.rotated ? "New signing secret" : "Signing secret"}
							description="Copy it now. It is only shown once."
						>
							<SecretReveal
								revealed={revealed}
								onDone={() => setRevealed(null)}
							/>
						</Split>
					)}

					{adding && (
						<Split
							title="Add endpoint"
							description="A public https URL. Cap posts the events you choose to it."
						>
							<AddEndpointForm
								appId={appId}
								eventTypes={eventTypes}
								onCancel={() => setAdding(false)}
								onPendingChange={setCreating}
								onCreated={(endpointId, url, secret) => {
									setAdding(false);
									setCreating(false);
									setRevealed({ endpointId, url, secret, rotated: false });
									router.refresh();
								}}
							/>
						</Split>
					)}
				</div>
			)}

			{endpoints.length === 0 ? (
				!adding &&
				!revealed && (
					<div
						className={clsx(
							PANEL,
							"flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-5",
						)}
					>
						<p className={clsx(MUTED, "m-0 text-[14px] leading-[1.55]")}>
							No endpoints yet.
						</p>
						<Button size="sm" onClick={startAdding}>
							Add endpoint
						</Button>
					</div>
				)
			) : (
				<section className="min-w-0">
					<h2 className="sr-only">Endpoints</h2>
					<Panel>
						<ul className="m-0 list-none p-0">
							{endpoints.map((endpoint) => (
								<EndpointRow
									key={endpoint.id}
									appId={appId}
									endpoint={endpoint}
									canRotate={locks.canRotate}
									canDelete={locks.canDelete}
									onDeleted={() =>
										setRevealed((current) =>
											current?.endpointId === endpoint.id ? null : current,
										)
									}
									onRotated={(secret) => {
										setAdding(false);
										setRevealed({
											endpointId: endpoint.id,
											url: endpoint.url,
											secret,
											rotated: true,
										});
									}}
								/>
							))}
						</ul>
					</Panel>
					{full && (
						<p className={clsx(FAINT, "m-0 mt-3 text-[13px] leading-[1.5]")}>
							An app can have {limit} endpoints. Delete one to add another.
						</p>
					)}
				</section>
			)}
		</>
	);
}

function SecretReveal({
	revealed,
	onDone,
}: {
	revealed: Revealed;
	onDone: () => void;
}) {
	return (
		<div>
			<p
				className={clsx(
					MONO,
					MUTED,
					"m-0 mb-1 truncate text-[12.5px] leading-[1.5]",
				)}
			>
				{revealed.url}
			</p>
			<div className="border-t border-[rgba(222,230,246,0.07)]">
				<KeyRow label="Signing secret" value={revealed.secret} sensitive />
			</div>
			<div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
				<CopyTextButton
					value={`CAP_WEBHOOK_SECRET=${revealed.secret}\n`}
					label="Copy as .env"
				/>
				<Button variant="quiet" size="sm" onClick={onDone}>
					Done
				</Button>
			</div>
			<p className="m-0 mt-3 text-[13px] leading-[1.5] text-[rgba(232,236,244,0.46)]">
				{revealed.rotated
					? "The old secret has stopped working. Update your server now."
					: "Your server checks each request's Cap-Signature header with it."}
			</p>
		</div>
	);
}

function AddEndpointForm({
	appId,
	eventTypes,
	onCancel,
	onPendingChange,
	onCreated,
}: {
	appId: string;
	eventTypes: readonly string[];
	onCancel: () => void;
	onPendingChange: (pending: boolean) => void;
	onCreated: (endpointId: string, url: string, secret: string) => void;
}) {
	const urlId = useId();
	const errorId = useId();
	const [url, setUrl] = useState("");
	const [events, setEvents] = useState<string[]>([...eventTypes]);
	const [error, setError] = useState<Problem | null>(null);

	const create = useMutation({
		mutationFn: () => createInfraWebhook(appId, { url: url.trim(), events }),
		onSuccess: (result) => {
			if (isFailure(result)) {
				setError(result);
				return;
			}
			toast.success("Endpoint added");
			onCreated(result.endpoint.id, result.endpoint.url, result.secret);
		},
		onError: () =>
			setError({ message: "Could not add the endpoint", hint: "Try again." }),
	});

	const ready = url.trim().length > 0 && !create.isPending;

	useEffect(() => {
		onPendingChange(create.isPending);
	}, [create.isPending, onPendingChange]);

	return (
		<form
			className="flex flex-col gap-5"
			onSubmit={(event) => {
				event.preventDefault();
				if (!ready) return;
				setError(null);
				create.mutate();
			}}
		>
			<div>
				<label
					htmlFor={urlId}
					className="mb-2 block text-[13px] text-[rgba(232,236,244,0.58)]"
				>
					Endpoint URL
				</label>
				<Input
					id={urlId}
					type="text"
					inputMode="url"
					value={url}
					maxLength={2048}
					autoFocus
					autoComplete="off"
					spellCheck={false}
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? errorId : undefined}
					onChange={(event) => {
						setUrl(event.target.value);
						if (error) setError(null);
					}}
					placeholder="https://example.com/webhooks/cap"
					className={clsx(MONO, "max-w-[520px] text-[13.5px]")}
				/>
			</div>
			<fieldset className="m-0 min-w-0 border-0 p-0">
				<legend className="mb-2 block p-0 text-[13px] text-[rgba(232,236,244,0.58)]">
					Events
				</legend>
				<div className="flex flex-wrap gap-2">
					{eventTypes.map((type) => (
						<Toggle
							key={type}
							label={type}
							on={events.includes(type)}
							onChange={(on) => {
								setEvents((current) =>
									on
										? eventTypes.filter(
												(item) => item === type || current.includes(item),
											)
										: current.filter((item) => item !== type),
								);
								if (error) setError(null);
							}}
						/>
					))}
				</div>
			</fieldset>
			{error && (
				<div
					id={errorId}
					role="alert"
					className="max-w-[520px] text-pretty text-[13.5px] leading-[1.5]"
				>
					<p className="m-0 text-[#F2A199]">{error.message}</p>
					{error.hint && (
						<p className={clsx(MUTED, "m-0 mt-0.5")}>{error.hint}</p>
					)}
				</div>
			)}
			<div className="flex flex-wrap gap-2">
				<Button type="submit" disabled={!ready} loading={create.isPending}>
					Add endpoint
				</Button>
				<Button variant="quiet" onClick={onCancel} disabled={create.isPending}>
					Cancel
				</Button>
			</div>
		</form>
	);
}

function EndpointState({ endpoint }: { endpoint: InfraWebhookEndpoint }) {
	const failing = endpoint.disabledByFailures;
	return (
		<span
			className={clsx(
				"inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] leading-none",
				endpoint.enabled
					? "text-[#E8ECF4]"
					: failing
						? "text-[#F2A199]"
						: "text-[rgba(232,236,244,0.58)]",
			)}
		>
			<span
				aria-hidden="true"
				className={clsx(
					"size-[5px] rounded-full",
					endpoint.enabled
						? "bg-white shadow-[0_0_6px_1px_rgba(214,228,255,0.8)]"
						: failing
							? "bg-[#F2A199]"
							: "bg-[rgba(232,236,244,0.45)]",
				)}
			/>
			{endpoint.enabled ? "On" : "Off"}
		</span>
	);
}

function EndpointRow({
	appId,
	endpoint,
	canRotate,
	canDelete,
	onRotated,
	onDeleted,
}: {
	appId: string;
	endpoint: InfraWebhookEndpoint;
	canRotate: boolean;
	canDelete: boolean;
	onRotated: (secret: string) => void;
	onDeleted: () => void;
}) {
	const router = useRouter();
	const [test, setTest] = useState<TestOutcome | null>(null);
	const [confirm, setConfirm] = useState<"rotate" | "delete" | null>(null);

	const refuse = (result: InfraWebhookFailure) => {
		showRefusal(result);
		if (result.status === 404) router.refresh();
	};

	const sendTest = useMutation({
		mutationFn: () => sendInfraWebhookTest(appId, endpoint.id),
		onMutate: () => setTest(null),
		onSuccess: (result) => {
			if (isFailure(result)) return refuse(result);
			setTest(result.test);
			router.refresh();
		},
		onError: () => toast.error("Could not send the test event"),
	});

	const toggle = useMutation({
		mutationFn: () =>
			setInfraWebhookEnabled(appId, endpoint.id, !endpoint.enabled),
		onSuccess: (result) => {
			if (isFailure(result)) return refuse(result);
			toast.success(
				result.endpoint.enabled ? "Endpoint turned on" : "Endpoint turned off",
			);
			router.refresh();
		},
		onError: () => toast.error("Could not change the endpoint"),
	});

	const rotate = useMutation({
		mutationFn: () => rotateInfraWebhookSecret(appId, endpoint.id),
		onSuccess: (result) => {
			setConfirm(null);
			if (isFailure(result)) return refuse(result);
			toast.success("New signing secret generated");
			onRotated(result.secret);
			router.refresh();
		},
		onError: () => toast.error("Could not rotate the signing secret"),
	});

	const remove = useMutation({
		mutationFn: () => deleteInfraWebhook(appId, endpoint.id),
		onSuccess: (result) => {
			setConfirm(null);
			if (isFailure(result)) return refuse(result);
			toast.success("Endpoint deleted");
			onDeleted();
			router.refresh();
		},
		onError: () => toast.error("Could not delete the endpoint"),
	});

	const busy =
		sendTest.isPending ||
		toggle.isPending ||
		rotate.isPending ||
		remove.isPending;

	return (
		<li className="border-b border-[rgba(222,230,246,0.07)] py-4">
			<div className="flex items-start justify-between gap-4">
				<p
					className={clsx(
						MONO,
						"m-0 min-w-0 text-[13.5px] leading-[1.5] text-[#E8ECF4] break-all",
					)}
				>
					{endpoint.url}
				</p>
				<span className="flex h-[20px] shrink-0 items-center">
					<EndpointState endpoint={endpoint} />
				</span>
			</div>
			<p className={clsx(FAINT, "m-0 mt-1.5 text-[13px] leading-[1.5]")}>
				<span className={MONO}>{endpoint.events.join(", ")}</span>
				<span aria-hidden="true"> · </span>
				<span className="sr-only">, signing secret </span>
				<span className={MONO}>
					{endpoint.secretPrefix}
					<span aria-hidden="true">••••</span>
				</span>
			</p>
			{endpoint.disabledByFailures && !endpoint.enabled && (
				<p className="m-0 mt-2 text-pretty text-[13.5px] leading-[1.5] text-[#F2A199]">
					Turned off by Cap after repeated failed deliveries. Fix the endpoint,
					send a test, then turn it on.
				</p>
			)}
			<p className={clsx(MUTED, "m-0 mt-2 text-[13.5px] leading-[1.5]")}>
				{lastDelivery(endpoint)}
			</p>
			<output
				aria-live="polite"
				className={clsx(
					"block text-[13.5px] leading-[1.5]",
					test ? "mt-1" : "sr-only",
					test?.delivered ? "text-[#E8ECF4]" : "text-[#F2A199]",
				)}
			>
				{test ? testText(test) : ""}
			</output>
			<div className="mt-3 flex flex-wrap gap-2">
				<Button
					variant="ghost"
					size="sm"
					loading={sendTest.isPending}
					disabled={busy}
					onClick={() => sendTest.mutate()}
				>
					Send test
				</Button>
				<Button
					variant="ghost"
					size="sm"
					loading={toggle.isPending}
					disabled={busy}
					onClick={() => toggle.mutate()}
				>
					{endpoint.enabled ? "Turn off" : "Turn on"}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					disabled={busy || !canRotate}
					onClick={() => setConfirm("rotate")}
				>
					Rotate secret
				</Button>
				<Button
					variant="danger"
					size="sm"
					disabled={busy || !canDelete}
					onClick={() => setConfirm("delete")}
				>
					Delete
				</Button>
			</div>

			<ConfirmDialog
				open={confirm === "rotate"}
				title="Rotate signing secret"
				description="The current secret stops working straight away, including for retries of earlier events. You get the new one once."
				confirmLabel="Rotate secret"
				loading={rotate.isPending}
				onConfirm={() => rotate.mutate()}
				onCancel={() => {
					if (!rotate.isPending) setConfirm(null);
				}}
			/>
			<ConfirmDialog
				open={confirm === "delete"}
				title="Delete endpoint"
				description={
					<>
						Cap stops sending events to{" "}
						<span className={clsx(MONO, "break-all")}>{endpoint.url}</span>{" "}
						straight away. This cannot be undone.
					</>
				}
				confirmLabel="Delete endpoint"
				loading={remove.isPending}
				onConfirm={() => remove.mutate()}
				onCancel={() => {
					if (!remove.isPending) setConfirm(null);
				}}
			/>
		</li>
	);
}
