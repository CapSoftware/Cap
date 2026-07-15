"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
} from "@cap/ui";
import { faFileImport } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { importFromLoom } from "@/actions/loom";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { UpgradeModal } from "@/components/UpgradeModal";

export const ImportLoomButton = ({
	size = "md",
}: {
	size?: "sm" | "lg" | "md";
}) => {
	const { user, activeOrganization } = useDashboardContext();
	const router = useRouter();
	const [dialogOpen, setDialogOpen] = useState(false);
	const [loomUrl, setLoomUrl] = useState("");
	const [isImporting, setIsImporting] = useState(false);
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);

	const handleClick = () => {
		if (!user) return;

		if (!user.isPro) {
			setUpgradeModalOpen(true);
			return;
		}

		setDialogOpen(true);
	};

	const handleImport = async () => {
		if (!loomUrl.trim() || !activeOrganization) return;

		setIsImporting(true);

		try {
			const result = await importFromLoom({
				loomUrl: loomUrl.trim(),
				orgId: activeOrganization.organization.id,
			});

			if (!result.success) {
				toast.error(result.error || "导入视频失败。");
				setIsImporting(false);
				return;
			}

			toast.success("Loom 视频已开始导入，稍后会显示在你的录制内容中。");
			setDialogOpen(false);
			setLoomUrl("");
			router.refresh();
		} catch {
			toast.error("发生意外错误，请重试。");
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
		<>
			<Button
				onClick={handleClick}
				variant="dark"
				className="flex gap-2 items-center"
				size={size}
			>
				<FontAwesomeIcon className="size-3.5" icon={faFileImport} />从 Loom 导入
			</Button>

			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent className="w-[calc(100%-20px)] max-w-md">
					<DialogHeader
						icon={<FontAwesomeIcon icon={faFileImport} className="size-3.5" />}
					>
						<DialogTitle>从 Loom 导入</DialogTitle>
					</DialogHeader>
					<div className="p-5">
						<p className="mb-3 text-sm text-gray-11">
							粘贴 Loom 视频网址，将其导入 Cap。视频将在后台下载并处理。
						</p>
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
					</div>
					<DialogFooter>
						<Button
							size="sm"
							variant="gray"
							onClick={() => {
								setDialogOpen(false);
								setLoomUrl("");
							}}
						>
							取消
						</Button>
						<Button
							onClick={handleImport}
							size="sm"
							spinner={isImporting}
							variant="dark"
							disabled={!isValidLoomUrl || isImporting}
						>
							{isImporting ? "正在导入……" : "导入"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<UpgradeModal
				open={upgradeModalOpen}
				onOpenChange={setUpgradeModalOpen}
			/>
		</>
	);
};
