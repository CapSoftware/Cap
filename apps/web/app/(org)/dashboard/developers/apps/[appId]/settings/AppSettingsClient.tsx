"use client";

import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
	Label,
} from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { deleteDeveloperApp } from "@/actions/developers/delete-app";
import { updateDeveloperApp } from "@/actions/developers/update-app";
import { useDevelopersContext } from "../../../DevelopersContext";

export function AppSettingsClient() {
	const { appId } = useParams<{ appId: string }>();
	const { apps } = useDevelopersContext();
	const app = apps.find((a) => a.id === appId);
	const router = useRouter();
	const nameInputId = useId();

	const [name, setName] = useState(app?.name ?? "");
	const [environment, setEnvironment] = useState(
		app?.environment ?? "development",
	);
	const [confirmDelete, setConfirmDelete] = useState(false);

	const updateMutation = useMutation({
		mutationFn: () =>
			updateDeveloperApp({
				appId,
				name,
				environment: environment as "development" | "production",
			}),
		onSuccess: () => {
			toast.success("应用已更新");
			router.refresh();
		},
		onError: () => toast.error("更新应用失败"),
	});

	const deleteMutation = useMutation({
		mutationFn: () => deleteDeveloperApp(appId),
		onSuccess: () => {
			toast.success("应用已删除");
			router.push("/dashboard/developers/apps");
			router.refresh();
		},
		onError: () => toast.error("删除应用失败"),
	});

	if (!app) {
		return <p className="text-sm text-gray-10">未找到应用</p>;
	}

	return (
		<div className="flex flex-col gap-5 max-w-xl">
			<Card>
				<CardHeader>
					<CardTitle>常规</CardTitle>
					<CardDescription>更新应用名称和环境。</CardDescription>
				</CardHeader>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						updateMutation.mutate();
					}}
					className="flex flex-col gap-4 mt-4"
				>
					<div className="flex flex-col gap-2">
						<Label htmlFor={nameInputId}>应用名称</Label>
						<Input
							id={nameInputId}
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label>环境</Label>
						<div className="flex gap-2">
							<Button
								type="button"
								variant={environment === "development" ? "dark" : "gray"}
								size="sm"
								onClick={() => setEnvironment("development")}
							>
								开发环境
							</Button>
							<Button
								type="button"
								variant={environment === "production" ? "dark" : "gray"}
								size="sm"
								onClick={() => setEnvironment("production")}
							>
								生产环境
							</Button>
						</div>
					</div>
					<Button
						type="submit"
						variant="dark"
						size="sm"
						className="self-start"
						spinner={updateMutation.isPending}
						disabled={updateMutation.isPending}
					>
						保存更改
					</Button>
				</form>
			</Card>

			<Card className="border-red-400/20">
				<CardHeader>
					<CardTitle className="text-red-400">危险区域</CardTitle>
					<CardDescription>
						删除应用将撤销所有 API 密钥，并停止所有 SDK 集成。
					</CardDescription>
				</CardHeader>
				<div className="mt-4">
					{!confirmDelete ? (
						<Button
							variant="gray"
							size="sm"
							onClick={() => setConfirmDelete(true)}
						>
							<Trash2 size={14} className="mr-1" />
							删除应用
						</Button>
					) : (
						<div className="flex gap-2">
							<Button
								variant="gray"
								size="sm"
								onClick={() => setConfirmDelete(false)}
							>
								取消
							</Button>
							<Button
								variant="dark"
								size="sm"
								className="!bg-red-400 hover:!bg-red-300"
								spinner={deleteMutation.isPending}
								disabled={deleteMutation.isPending}
								onClick={() => deleteMutation.mutate()}
							>
								确认删除
							</Button>
						</div>
					)}
				</div>
			</Card>
		</div>
	);
}
