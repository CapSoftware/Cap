"use client";

import { Button } from "@cap/ui";
import { Effect } from "effect";
import { useRouter } from "next/navigation";
import { type MouseEvent, startTransition, useState } from "react";
import { toast } from "sonner";
import { UpgradeModal } from "@/components/UpgradeModal";
import { useEffectMutation } from "@/lib/EffectRuntime";
import { withRpc } from "@/lib/Rpcs";
import { Base } from "./Base";

export function CustomDomainPage() {
	const router = useRouter();
	const [showUpgradeModal, setShowUpgradeModal] = useState(false);

	const customDomainMutation = useEffectMutation({
		mutationFn: () =>
			Effect.gen(function* () {
				yield* withRpc((r) =>
					r.UserCompleteOnboardingStep({
						step: "customDomain",
						data: undefined,
					}),
				);
			}),
		onSuccess: () => {
			startTransition(() => {
				router.push("/onboarding/invite-team");
				router.refresh();
			});
		},
		onError: () => {
			toast.error("An error occurred, please try again");
		},
	});

	const handleSubmit = async (e: MouseEvent<HTMLButtonElement>) => {
		e.preventDefault();
		await customDomainMutation.mutateAsync();
	};

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
				onClick={handleSubmit}
			>
				Skip
			</Button>

			<UpgradeModal
				onCheckout={handleSubmit}
				onboarding={true}
				open={showUpgradeModal}
				onOpenChange={setShowUpgradeModal}
			/>
		</Base>
	);
}
