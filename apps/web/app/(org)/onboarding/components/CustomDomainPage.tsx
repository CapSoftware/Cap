"use client";

import { Button } from "@inflight/ui";
import { useRouter } from "next/navigation";
import { startTransition, useState } from "react";
import { toast } from "sonner";
import { UpgradeModal } from "@/components/UpgradeModal";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { Base } from "./Base";

export function CustomDomainPage() {
	const router = useRouter();
	const rpc = useRpcClient();
	const [showUpgradeModal, setShowUpgradeModal] = useState(false);

	const customDomainMutation = useEffectMutation({
		mutationFn: (_redirect: boolean) =>
			rpc.UserCompleteOnboardingStep({
				step: "customDomain",
				data: undefined,
			}),
		onSuccess: (_, redirect) => {
			startTransition(() => {
				if (redirect) {
					router.push("/onboarding/invite-team");
					router.refresh();
				}
			});
		},
		onError: () => {
			toast.error("An error occurred, please try again");
		},
	});

	const handleSubmit = async (redirect = true) =>
		await customDomainMutation.mutateAsync(redirect);

	return (
		<Base
			title="Custom Domain"
			description={
				<div>
					<p className="w-full text-base max-w-[340px] text-gray-10">
						Pro users can setup a custom domain to access their shareable Cap
						links i.e{" "}
						<span className="font-medium text-blue-500">
							cap.yourdomain.com
						</span>
					</p>
				</div>
			}
			descriptionClassName="max-w-[400px]"
		>
			<Button
				onClick={() => setShowUpgradeModal(true)}
				className="w-full"
				disabled={customDomainMutation.isPending}
				variant="blue"
			>
				Upgrade to Pro
			</Button>
			<div className="w-full h-px bg-gray-4" />
			<Button
				type="button"
				variant="dark"
				spinner={customDomainMutation.isPending}
				disabled={customDomainMutation.isPending}
				className="mx-auto w-full"
				onClick={() => handleSubmit()}
			>
				Skip
			</Button>
			<UpgradeModal
				onCheckout={async () => {
					await handleSubmit();
				}}
				onboarding={true}
				open={showUpgradeModal}
				onOpenChange={setShowUpgradeModal}
			/>
		</Base>
	);
}
