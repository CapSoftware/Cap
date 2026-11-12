"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { regenerateDeveloperKeys } from "@/actions/developers/regenerate-keys";
import { KeyRow } from "../../_components/copy";
import { KeysReveal } from "../../_components/create-app";
import { ConfirmDialog } from "../../_components/dialog";
import { Button, PageHeader, Split } from "../../_components/ui";

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
			<PageHeader
				title="API keys"
				description="Use the public key in the browser to create and upload videos. Use the secret key on your server to read and delete them."
			/>

			<div>
				{newKeys ? (
					<Split
						title="Your new keys"
						description="Copy the secret key now. It is only shown once."
					>
						<KeysReveal app={{ appId, ...newKeys }} />
					</Split>
				) : (
					<Split
						title="Current keys"
						description="The secret key is hidden after it is created."
					>
						<div className="border-t border-[rgba(222,230,246,0.07)]">
							{publicKey && <KeyRow label="Public key" value={publicKey} />}
							<KeyRow
								label="Secret key"
								value={`${secretKeyPrefix ?? "csk_"}${"•".repeat(24)}`}
								copyable={false}
							/>
						</div>
					</Split>
				)}

				<Split
					title="Generate new keys"
					description="Revokes both current keys immediately. Use this if you lost the secret key or it leaked."
				>
					<Button variant="ghost" onClick={() => setConfirmOpen(true)}>
						Generate new keys
					</Button>
				</Split>
			</div>

			<ConfirmDialog
				open={confirmOpen}
				title="Generate new keys"
				description="Both current keys stop working right away. Anything still using them will fail until you switch to the new pair."
				confirmLabel="Generate new keys"
				loading={regenerate.isPending}
				onConfirm={() => regenerate.mutate()}
				onCancel={() => {
					if (!regenerate.isPending) setConfirmOpen(false);
				}}
			/>
		</>
	);
}
