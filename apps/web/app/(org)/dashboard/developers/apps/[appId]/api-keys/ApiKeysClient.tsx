"use client";

import { Button, Card, CardHeader, CardTitle } from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { regenerateDeveloperKeys } from "@/actions/developers/regenerate-keys";
import { ApiKeyDisplay } from "../../../_components/ApiKeyDisplay";
import { useDevelopersContext } from "../../../DevelopersContext";

export function ApiKeysClient() {
	const { appId } = useParams<{ appId: string }>();
	const { apps } = useDevelopersContext();
	const app = apps.find((a) => a.id === appId);
	const router = useRouter();

	const [newKeys, setNewKeys] = useState<{
		publicKey: string;
		secretKey: string;
	} | null>(null);
	const [confirmRegenerate, setConfirmRegenerate] = useState(false);

	const regenerateMutation = useMutation({
		mutationFn: () => regenerateDeveloperKeys(appId),
		onSuccess: (result) => {
			setNewKeys(result);
			setConfirmRegenerate(false);
			toast.success("Keys regenerated");
			router.refresh();
		},
		onError: () => toast.error("Failed to regenerate keys"),
	});

	if (!app) {
		return <p className="text-sm text-gray-10">App not found</p>;
	}

	const publicKey = app.apiKeys.find((k) => k.keyType === "public");
	const secretKey = app.apiKeys.find((k) => k.keyType === "secret");

	return (
		<div className="flex flex-col gap-5 max-w-xl">
			{newKeys && (
				<Card className="border-green-400/20 bg-green-400/5">
					<p className="text-sm font-medium text-green-400 mb-4">
						New keys generated. Save your secret key now!
					</p>
					<div className="flex flex-col gap-4">
						<ApiKeyDisplay label="Public Key" value={newKeys.publicKey} />
						<ApiKeyDisplay
							label="Secret Key"
							value={newKeys.secretKey}
							sensitive
						/>
					</div>
				</Card>
			)}

			<Card>
				<CardHeader>
					<CardTitle>Current Keys</CardTitle>
				</CardHeader>
				<div className="flex flex-col gap-3 mt-4">
					{publicKey && (
						<ApiKeyDisplay
							label="Public Key"
							value={publicKey.fullKey ?? `${publicKey.keyPrefix}...`}
						/>
					)}
					{secretKey && (
						<div className="flex flex-col gap-1.5">
							<span className="text-xs font-medium text-gray-10">
								Secret Key
							</span>
							<code className="px-3 py-2 text-xs rounded-lg bg-gray-3 text-gray-11 font-mono">
								{"•".repeat(24)}
							</code>
							<p className="text-xs text-gray-10">
								Regenerate to reveal a new secret key
							</p>
						</div>
					)}
				</div>
			</Card>

			<Card className="border-red-400/20">
				<CardHeader>
					<CardTitle className="text-red-400">Regenerate Keys</CardTitle>
				</CardHeader>
				<div className="mt-4">
					{!confirmRegenerate ? (
						<Button
							variant="gray"
							size="sm"
							onClick={() => setConfirmRegenerate(true)}
						>
							<RefreshCw size={14} className="mr-1" />
							Regenerate Keys
						</Button>
					) : (
						<div className="flex gap-2">
							<Button
								variant="gray"
								size="sm"
								onClick={() => setConfirmRegenerate(false)}
							>
								Cancel
							</Button>
							<Button
								variant="dark"
								size="sm"
								className="!bg-red-400 hover:!bg-red-300"
								spinner={regenerateMutation.isPending}
								disabled={regenerateMutation.isPending}
								onClick={() => regenerateMutation.mutate()}
							>
								Confirm Regenerate
							</Button>
						</div>
					)}
				</div>
			</Card>
		</div>
	);
}
