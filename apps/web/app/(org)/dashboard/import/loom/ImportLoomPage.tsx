"use client";

import { Button, Input } from "@cap/ui";
import { faArrowLeft } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { importFromLoom } from "@/actions/loom";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { UpgradeModal } from "@/components/UpgradeModal";

export const ImportLoomPage = () => {
	const { user, activeOrganization } = useDashboardContext();
	const router = useRouter();
	const [loomUrl, setLoomUrl] = useState("");
	const [isImporting, setIsImporting] = useState(false);
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(!user?.isPro);

	const handleImport = async () => {
		if (!user || !activeOrganization) return;

		if (!user.isPro) {
			setUpgradeModalOpen(true);
			return;
		}

		if (!loomUrl.trim()) return;

		setIsImporting(true);

		try {
			const result = await importFromLoom({
				loomUrl: loomUrl.trim(),
				orgId: activeOrganization.organization.id,
			});

			if (!result.success) {
				toast.error(result.error || "Failed to import video.");
				setIsImporting(false);
				return;
			}

			toast.success(
				"Loom video import started! It will appear in your caps shortly.",
			);
			router.push("/dashboard/caps");
		} catch {
			toast.error("An unexpected error occurred. Please try again.");
		} finally {
			setIsImporting(false);
		}
	};

	const isValidLoomUrl = (() => {
		try {
			const parsed = new URL(loomUrl.trim());
			return parsed.hostname.includes("loom.com");
		} catch {
			return false;
		}
	})();

	return (
		<div className="flex flex-col w-full h-full">
			<div className="mb-8">
				<Link
					href="/dashboard/import"
					className="inline-flex gap-2 items-center text-sm text-gray-10 hover:text-gray-12 transition-colors mb-4"
				>
					<FontAwesomeIcon className="size-3" icon={faArrowLeft} />
					Back to Import
				</Link>
				<h1 className="text-2xl font-medium text-gray-12">Import from Loom</h1>
				<p className="mt-1 text-sm text-gray-10">
					Paste a Loom video URL to import it to Cap.
				</p>
			</div>

			<div className="flex flex-col gap-6 w-full max-w-2xl">
				<div className="flex flex-col gap-4 p-6 rounded-xl border border-gray-3 bg-gray-1">
					<div className="flex items-center gap-3">
						<div className="flex items-center justify-center size-10 rounded-full bg-gray-3">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="18"
								height="18"
								viewBox="0 0 16 16"
								fill="none"
								role="img"
								aria-label="Loom"
							>
								<path
									fill="#625DF5"
									d="M15 7.222h-4.094l3.546-2.047-.779-1.35-3.545 2.048 2.046-3.546-1.349-.779L8.78 5.093V1H7.22v4.094L5.174 1.548l-1.348.779 2.046 3.545-3.545-2.046-.779 1.348 3.546 2.047H1v1.557h4.093l-3.545 2.047.779 1.35 3.545-2.047-2.047 3.545 1.35.779 2.046-3.546V15h1.557v-4.094l2.047 3.546 1.349-.779-2.047-3.546 3.545 2.047.779-1.349-3.545-2.046h4.093L15 7.222zm-7 2.896a2.126 2.126 0 110-4.252 2.126 2.126 0 010 4.252z"
								/>
							</svg>
						</div>
						<div>
							<p className="text-sm font-medium text-gray-12">Loom Video URL</p>
							<p className="text-xs text-gray-10">
								The video will be downloaded and processed in the background.
							</p>
						</div>
					</div>

					<Input
						value={loomUrl}
						onChange={(e) => setLoomUrl(e.target.value)}
						placeholder="https://www.loom.com/share/..."
						onKeyDown={(e) => {
							if (e.key === "Enter" && isValidLoomUrl && !isImporting) {
								handleImport();
							}
						}}
					/>

					<div className="flex gap-3 justify-end">
						<Button
							size="sm"
							variant="gray"
							onClick={() => router.push("/dashboard/import")}
						>
							Cancel
						</Button>
						<Button
							onClick={handleImport}
							size="sm"
							spinner={isImporting}
							variant="dark"
							disabled={!isValidLoomUrl || isImporting}
						>
							{isImporting ? "Importing..." : "Import Video"}
						</Button>
					</div>
				</div>
			</div>

			<UpgradeModal
				open={upgradeModalOpen}
				onOpenChange={setUpgradeModalOpen}
			/>
		</div>
	);
};
