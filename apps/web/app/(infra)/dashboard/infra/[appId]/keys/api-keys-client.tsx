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
	secretKeyPrefix,
}: {
	appId: string;
	secretKeyPrefix: string | null;
}) {
	const router = useRouter();
	const [newSecretKey, setNewSecretKey] = useState<string | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);

	const regenerate = useMutation({
		mutationFn: () => regenerateDeveloperKeys(appId),
		onSuccess: (result) => {
			setNewSecretKey(result.secretKey);
			setConfirmOpen(false);
			toast.success("New secret key generated");
			router.refresh();
		},
		onError: () => toast.error("Could not generate a new secret key"),
	});

	return (
		<>
			<PageHeader
				title="API keys"
				description="One secret key per app. It belongs on your server, where it creates uploads and reads and deletes videos. Browsers upload with a token your server issues, never with the key."
			/>

			<div>
				{newSecretKey ? (
					<Split
						title="Your new secret key"
						description="Copy it now. It is only shown once."
					>
						<KeysReveal secretKey={newSecretKey} />
					</Split>
				) : (
					<Split title="Secret key" description="Hidden after it is created.">
						<div className="border-t border-[rgba(222,230,246,0.07)]">
							<KeyRow
								label="Secret key"
								value={`${secretKeyPrefix ?? "csk_"}${"•".repeat(24)}`}
								copyable={false}
							/>
						</div>
					</Split>
				)}

				<Split
					title="Generate a new secret key"
					description="Revokes the current key immediately. Use this if you lost it or it leaked."
				>
					<Button variant="ghost" onClick={() => setConfirmOpen(true)}>
						Generate a new secret key
					</Button>
				</Split>
			</div>

			<ConfirmDialog
				open={confirmOpen}
				title="Generate a new secret key"
				description="The current key stops working right away. Anything still using it will fail until you switch to the new one."
				confirmLabel="Generate new key"
				loading={regenerate.isPending}
				onConfirm={() => regenerate.mutate()}
				onCancel={() => {
					if (!regenerate.isPending) setConfirmOpen(false);
				}}
			/>
		</>
	);
}
