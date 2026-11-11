"use client";

import { Button } from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { regenerateDeveloperKeys } from "@/actions/developers/regenerate-keys";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { ApiKeyDisplay } from "../../_components/api-key-display";
import { Panel, Section } from "../../_components/section";

export function ApiKeysClient({
	appId,
	publicKey,
	secretKeyPrefix,
}: {
	appId: string;
	publicKey: string | null;
	secretKeyPrefix: string | null;
}) {
	const router = useRouter();
	const [newKeys, setNewKeys] = useState<{
		publicKey: string;
		secretKey: string;
	} | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);

	const regenerate = useMutation({
		mutationFn: () => regenerateDeveloperKeys(appId),
		onSuccess: (result) => {
			setNewKeys(result);
			setConfirmOpen(false);
			toast.success("New keys generated");
			router.refresh();
		},
		onError: () => toast.error("Could not generate new keys"),
	});

	return (
		<>
			{newKeys && (
				<Section
					title="Your new keys"
					description="Copy the secret key now. It is only shown once."
				>
					<Panel className="flex flex-col gap-4 p-5 border-gray-6">
						<ApiKeyDisplay label="Public key" value={newKeys.publicKey} />
						<ApiKeyDisplay
							label="Secret key"
							value={newKeys.secretKey}
							sensitive
						/>
					</Panel>
				</Section>
			)}

			<Section
				title="API keys"
				description="Use the public key in the browser to create and upload videos. Use the secret key on your server to read and delete them."
			>
				<Panel className="flex flex-col gap-5 p-5">
					{publicKey && !newKeys && (
						<ApiKeyDisplay label="Public key" value={publicKey} />
					)}
					{!newKeys && (
						<div className="flex flex-col gap-1.5">
							<span className="text-xs font-medium text-gray-12">
								Secret key
							</span>
							<code className="px-3 py-2 font-mono text-xs truncate rounded-lg bg-gray-3 text-gray-11">
								{secretKeyPrefix ?? "csk_"}
								{"•".repeat(20)}
							</code>
							<p className="text-xs text-gray-10">
								Hidden after it is created. Generate a new pair if you lost it.
							</p>
						</div>
					)}
					<div className="flex flex-wrap gap-4 justify-between items-center pt-5 border-t border-gray-3">
						<p className="text-sm text-gray-10">
							Generating new keys revokes both current keys immediately.
						</p>
						<Button
							variant="gray"
							size="sm"
							onClick={() => setConfirmOpen(true)}
						>
							Generate new keys
						</Button>
					</div>
				</Panel>
			</Section>

			<ConfirmationDialog
				open={confirmOpen}
				title="Generate new keys"
				description="Both current keys stop working right away. Anything still using them will fail until you switch to the new pair."
				confirmLabel="Generate new keys"
				confirmVariant="destructive"
				loading={regenerate.isPending}
				onConfirm={() => regenerate.mutate()}
				onCancel={() => {
					if (!regenerate.isPending) setConfirmOpen(false);
				}}
			/>
		</>
	);
}
