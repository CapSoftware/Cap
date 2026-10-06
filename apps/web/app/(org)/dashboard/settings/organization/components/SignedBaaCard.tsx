"use client";

import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	Input,
} from "@cap/ui";
import { faFileSignature } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { useRouter, useSearchParams } from "next/navigation";
import {
	Suspense,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	confirmSignedBaaPayment,
	getSignedBaaStatus,
	purchaseSignedBaa,
	type SignedBaaInput,
	type SignedBaaStatus,
	signPaidBaa,
} from "@/actions/organization/signed-baa";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { SignaturePad } from "./SignaturePad";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FormState = Omit<SignedBaaInput, "signatureDataUrl">;

const EMPTY_FORM: FormState = {
	entityName: "",
	entityType: "",
	entityAddress: "",
	signerName: "",
	signerTitle: "",
	noticesEmail: "",
};

export function SignedBaaCard() {
	const { activeOrganization } = useDashboardContext();

	return (
		<Suspense
			fallback={<div className="h-32 rounded-xl animate-pulse bg-gray-4" />}
		>
			<SignedBaaCardContent key={activeOrganization?.organization.id} />
		</Suspense>
	);
}

function SignedBaaCardContent() {
	const { activeOrganization, user } = useDashboardContext();
	const router = useRouter();
	const searchParams = useSearchParams();
	const queryClient = useQueryClient();
	const organizationId = activeOrganization?.organization.id;
	const isBaaRedirect = searchParams.get("baaRedirect") === "true";
	const sessionId = searchParams.get("session_id");
	const fieldIdPrefix = useId();
	const handledSessionId = useRef<string | null>(null);

	const [dialogOpen, setDialogOpen] = useState(false);
	const [form, setForm] = useState<FormState>(EMPTY_FORM);
	const [signature, setSignature] = useState<{
		paid: boolean;
		dataUrl: string;
	} | null>(null);

	const {
		data: baa,
		isLoading,
		isError: statusFailed,
		refetch: refetchStatus,
	} = useQuery<SignedBaaStatus | null>({
		queryKey: ["signed-baa", organizationId],
		queryFn: () => {
			if (!organizationId) return null;
			return getSignedBaaStatus(organizationId);
		},
		enabled: !!organizationId,
		staleTime: 60 * 1000,
		refetchInterval: (query) =>
			query.state.data?.status === "processing" ? 3000 : false,
	});

	const paymentConfirmation = useQuery({
		queryKey: ["signed-baa-payment", organizationId, sessionId],
		queryFn: async () => {
			if (!organizationId || !sessionId) {
				throw new Error("The payment confirmation link is incomplete.");
			}
			const result = await confirmSignedBaaPayment(organizationId, sessionId);
			if (result.status === "none" || result.status === "canceled") {
				throw new Error("Your BAA payment could not be confirmed.");
			}
			const queryKey = ["signed-baa", organizationId];
			await queryClient.cancelQueries({ queryKey, exact: true });
			queryClient.setQueryData(queryKey, result);
			await queryClient.invalidateQueries({ queryKey, exact: true });
			return result;
		},
		enabled: isBaaRedirect && !!organizationId && !!sessionId,
		retry: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		gcTime: 0,
	});

	const verificationPending =
		isBaaRedirect &&
		!!sessionId &&
		(paymentConfirmation.isPending || paymentConfirmation.isFetching);
	const verificationError = isBaaRedirect
		? !sessionId
			? "The payment confirmation link is incomplete. Reopen the link from checkout or contact hello@cap.so."
			: paymentConfirmation.error?.message
		: null;
	const verificationBlocked =
		isBaaRedirect &&
		(!sessionId || !paymentConfirmation.isSuccess || verificationPending);
	const isActive = baa?.status === "active";
	const isPaid = baa?.status === "paid";
	const signatureDataUrl =
		signature?.paid === isPaid ? signature.dataUrl : null;
	const isProcessing = baa?.status === "processing";
	const canPurchase = Boolean(baa?.canPurchase);
	const actionsBlocked =
		!organizationId ||
		isLoading ||
		statusFailed ||
		verificationBlocked ||
		isProcessing ||
		isActive ||
		(!isPaid && !canPurchase);

	const signatureMutation = useMutation({
		mutationFn: () => {
			if (!organizationId) throw new Error("No organization");
			if (actionsBlocked) throw new Error("Please wait for your BAA status.");
			if (!signatureDataUrl) throw new Error("Please add your signature");
			const input = {
				...form,
				signatureDataUrl,
			};
			return isPaid
				? signPaidBaa(organizationId, input)
				: purchaseSignedBaa(organizationId, input);
		},
		onSuccess: (result) => {
			toast.success(
				result.emailSent
					? "Signed BAA is active — a signed copy is on its way to your inbox"
					: "Signed BAA is active — download your signed copy below",
			);
			setDialogOpen(false);
			setForm(EMPTY_FORM);
			setSignature(null);
			queryClient.invalidateQueries({
				queryKey: ["signed-baa", organizationId],
			});
			router.refresh();
		},
		onError: (error) => {
			queryClient.invalidateQueries({
				queryKey: ["signed-baa", organizationId],
			});
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to complete your Signed BAA",
			);
		},
	});

	const openDialog = useCallback(() => {
		setForm({
			...(baa?.details ?? EMPTY_FORM),
			signerName:
				baa?.details?.signerName ||
				[user.name, user.lastName].filter(Boolean).join(" "),
			noticesEmail: baa?.details?.noticesEmail || user.email,
		});
		setSignature(null);
		setDialogOpen(true);
	}, [baa?.details, user.name, user.lastName, user.email]);

	useEffect(() => {
		if (
			isBaaRedirect &&
			sessionId &&
			!verificationBlocked &&
			!statusFailed &&
			!isLoading &&
			(isPaid || isActive) &&
			handledSessionId.current !== sessionId
		) {
			handledSessionId.current = sessionId;
			if (isPaid) openDialog();
			const url = new URL(window.location.href);
			if (
				url.searchParams.get("baaRedirect") === "true" &&
				url.searchParams.get("session_id") === sessionId
			) {
				url.searchParams.delete("baaRedirect");
				url.searchParams.delete("session_id");
				router.replace(`${url.pathname}${url.search}${url.hash}`, {
					scroll: false,
				});
			}
		}
	}, [
		isBaaRedirect,
		sessionId,
		verificationBlocked,
		statusFailed,
		isLoading,
		isPaid,
		isActive,
		openDialog,
		router,
	]);

	const updateField =
		(field: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
			setForm((current) => ({ ...current, [field]: e.target.value }));

	const formValid =
		form.entityName.trim().length >= 2 &&
		form.entityType.trim().length >= 2 &&
		form.entityAddress.trim().length >= 2 &&
		form.signerName.trim().length >= 2 &&
		form.signerTitle.trim().length >= 2 &&
		EMAIL_REGEX.test(form.noticesEmail.trim()) &&
		Boolean(signatureDataUrl);

	const downloadUrl = organizationId
		? `/api/settings/billing/baa/download?organizationId=${organizationId}`
		: "#";

	const fields: {
		key: keyof FormState;
		label: string;
		placeholder: string;
		type?: string;
		fullWidth?: boolean;
	}[] = [
		{
			key: "entityName",
			label: "Company legal name",
			placeholder: "Acme Health, Inc.",
		},
		{
			key: "entityType",
			label: "Entity type",
			placeholder: "Delaware corporation",
		},
		{
			key: "entityAddress",
			label: "Company address",
			placeholder: "123 Main St, Suite 100, San Francisco, CA 94105",
			fullWidth: true,
		},
		{ key: "signerName", label: "Your full name", placeholder: "Jane Smith" },
		{ key: "signerTitle", label: "Your title", placeholder: "CEO" },
		{
			key: "noticesEmail",
			label: "Email for legal notices",
			placeholder: "legal@company.com",
			type: "email",
			fullWidth: true,
		},
	];

	return (
		<Card className="flex flex-col">
			<CardHeader>
				<CardTitle>Signed BAA</CardTitle>
				<CardDescription>
					HIPAA Business Associate Agreement between your organization and Cap
					Software, Inc.
				</CardDescription>
			</CardHeader>
			<div className="flex flex-wrap gap-5 justify-between items-center pt-4 mt-auto">
				{verificationPending ? (
					<output className="text-sm text-gray-11">
						Confirming your BAA payment...
					</output>
				) : verificationError ? (
					<div className="flex flex-col gap-3 text-sm text-gray-11">
						<p role="alert">{verificationError}</p>
						<p>Do not pay again. We need to verify your existing payment.</p>
						{sessionId && (
							<Button
								type="button"
								size="sm"
								variant="gray"
								onClick={() => paymentConfirmation.refetch()}
							>
								Retry payment confirmation
							</Button>
						)}
					</div>
				) : statusFailed ? (
					<div className="flex flex-col gap-3 text-sm text-gray-11">
						<p role="alert">
							Unable to load your BAA status. Please try again.
						</p>
						<Button
							type="button"
							size="sm"
							variant="gray"
							onClick={() => refetchStatus()}
						>
							Retry
						</Button>
					</div>
				) : isLoading ? (
					<div className="h-5 w-64 rounded animate-pulse bg-gray-4" />
				) : isActive ? (
					<>
						<div className="flex gap-2 items-center text-sm text-gray-11">
							<span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
								Active
							</span>
							{baa?.signedAt && (
								<span>
									Signed {format(new Date(baa.signedAt), "MMM d, yyyy")}
									{baa.entityName ? ` for ${baa.entityName}` : ""}
								</span>
							)}
						</div>
						<Button
							type="button"
							size="sm"
							variant="dark"
							onClick={() => {
								window.location.href = downloadUrl;
							}}
						>
							Download signed copy
						</Button>
					</>
				) : isPaid ? (
					<>
						<div className="flex flex-col gap-1 text-sm text-gray-11">
							<span className="font-medium text-gray-12">
								Paid — awaiting signature
							</span>
							<span>
								Payment received. Complete your details and sign your agreement.
							</span>
						</div>
						<Button
							type="button"
							size="sm"
							variant="primary"
							disabled={actionsBlocked || signatureMutation.isPending}
							onClick={openDialog}
						>
							Complete and sign BAA
						</Button>
					</>
				) : isProcessing ? (
					<output className="text-sm text-gray-11">
						Your BAA is processing. Please wait before trying again.
					</output>
				) : (
					<>
						<div className="flex flex-col gap-1 text-sm text-gray-11">
							<span>
								<span className="font-medium text-gray-12">$99/mo</span> — sign,
								pay, and receive your countersigned agreement instantly.
							</span>
							{!canPurchase && (
								<span className="text-xs text-gray-10">
									Requires an active Cap Pro subscription with a card on file.
								</span>
							)}
						</div>
						<Button
							type="button"
							size="sm"
							variant="primary"
							disabled={actionsBlocked || signatureMutation.isPending}
							onClick={openDialog}
						>
							Get Signed BAA
						</Button>
					</>
				)}
			</div>

			<Dialog
				open={dialogOpen && !verificationBlocked && !isActive}
				onOpenChange={(open) => {
					if (!signatureMutation.isPending) setDialogOpen(open);
				}}
			>
				<DialogContent className="p-0 w-[calc(100%-20px)] max-w-lg rounded-xl border bg-gray-2 border-gray-4">
					<DialogHeader
						icon={
							<FontAwesomeIcon icon={faFileSignature} className="size-3.5" />
						}
						description="Execute a HIPAA Business Associate Agreement with Cap Software, Inc."
					>
						<DialogTitle>Signed BAA</DialogTitle>
					</DialogHeader>
					<div className="flex overflow-y-auto flex-col gap-4 p-5 max-h-[55vh]">
						<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
							{fields.map((field) => (
								<div
									key={field.key}
									className={`flex flex-col gap-1.5 ${
										field.fullWidth ? "sm:col-span-2" : ""
									}`}
								>
									<label
										htmlFor={`${fieldIdPrefix}-${field.key}`}
										className="text-sm font-medium text-gray-12"
									>
										{field.label}
									</label>
									<Input
										id={`${fieldIdPrefix}-${field.key}`}
										type={field.type ?? "text"}
										value={form[field.key]}
										placeholder={field.placeholder}
										onChange={updateField(field.key)}
										disabled={actionsBlocked || signatureMutation.isPending}
									/>
								</div>
							))}
						</div>
						<div className="flex flex-col gap-1.5 shrink-0">
							<span className="text-sm font-medium text-gray-12">
								Signature
							</span>
							<SignaturePad
								key={isPaid ? "paid" : "purchase"}
								onChange={(dataUrl) =>
									setSignature(dataUrl ? { paid: isPaid, dataUrl } : null)
								}
								disabled={actionsBlocked || signatureMutation.isPending}
							/>
						</div>
					</div>
					<div className="flex flex-col gap-4 p-5 border-t border-gray-4">
						<p className="text-xs leading-5 text-gray-11">
							{isPaid ? (
								"Payment has already been received. Signing completes your Business Associate Agreement with no additional charge. Your existing $99/month BAA subscription continues on its current billing schedule, separately from Cap Pro."
							) : (
								<>
									By signing, you execute the Business Associate Agreement and
									authorize Cap to charge the card on file{" "}
									<span className="font-medium text-gray-12">$99/month</span>{" "}
									starting today. This is a separate subscription from Cap Pro
									and is not prorated. Once purchased, the Signed BAA can't be
									disabled; it ends automatically if your Cap Pro subscription
									is canceled.
								</>
							)}{" "}
							A countersigned PDF will be emailed to you and hello@cap.so.
						</p>
						<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
							<Button
								type="button"
								size="sm"
								variant="gray"
								onClick={() => setDialogOpen(false)}
								disabled={signatureMutation.isPending}
							>
								Cancel
							</Button>
							<Button
								type="button"
								size="sm"
								variant="primary"
								spinner={signatureMutation.isPending}
								disabled={
									!formValid || actionsBlocked || signatureMutation.isPending
								}
								onClick={() => signatureMutation.mutate()}
							>
								{signatureMutation.isPending
									? "Processing..."
									: isPaid
										? "Sign BAA"
										: "Sign & pay $99/mo"}
							</Button>
						</div>
					</div>
				</DialogContent>
			</Dialog>
		</Card>
	);
}
