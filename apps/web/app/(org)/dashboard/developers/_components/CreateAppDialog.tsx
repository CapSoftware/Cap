"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Label,
} from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { createDeveloperApp } from "@/actions/developers/create-app";
import { ApiKeyDisplay } from "./ApiKeyDisplay";

export function CreateAppDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const router = useRouter();
	const appNameId = useId();
	const [step, setStep] = useState<"create" | "keys">("create");
	const [name, setName] = useState("");
	const [environment, setEnvironment] = useState<"development" | "production">(
		"development",
	);
	const [keys, setKeys] = useState<{
		publicKey: string;
		secretKey: string;
	} | null>(null);

	const createMutation = useMutation({
		mutationFn: () => createDeveloperApp({ name, environment }),
		onSuccess: (result) => {
			setKeys({
				publicKey: result.publicKey,
				secretKey: result.secretKey,
			});
			setStep("keys");
			router.refresh();
		},
		onError: (error) => {
			toast.error(error instanceof Error ? error.message : "创建应用失败");
		},
	});

	const handleClose = () => {
		setStep("create");
		setName("");
		setEnvironment("development");
		setKeys(null);
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent className="max-w-md">
				{step === "create" && (
					<>
						<DialogHeader>
							<DialogTitle>创建开发者应用</DialogTitle>
						</DialogHeader>
						<div className="flex flex-col gap-4 p-5">
							<div className="flex flex-col gap-2">
								<Label htmlFor={appNameId}>应用名称</Label>
								<Input
									id={appNameId}
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="我的应用"
								/>
							</div>
							<div className="flex flex-col gap-2">
								<Label>环境</Label>
								<div className="flex gap-2">
									<Button
										variant={environment === "development" ? "dark" : "gray"}
										size="sm"
										onClick={() => setEnvironment("development")}
									>
										开发环境
									</Button>
									<Button
										variant={environment === "production" ? "dark" : "gray"}
										size="sm"
										onClick={() => setEnvironment("production")}
									>
										生产环境
									</Button>
								</div>
							</div>
						</div>
						<DialogFooter>
							<Button variant="gray" size="sm" onClick={handleClose}>
								取消
							</Button>
							<Button
								variant="dark"
								size="sm"
								disabled={!name.trim() || createMutation.isPending}
								spinner={createMutation.isPending}
								onClick={() => createMutation.mutate()}
							>
								创建
							</Button>
						</DialogFooter>
					</>
				)}
				{step === "keys" && keys && (
					<>
						<DialogHeader>
							<DialogTitle>API 密钥已创建</DialogTitle>
						</DialogHeader>
						<div className="flex flex-col gap-4 p-5">
							<p className="text-sm text-gray-10">
								请立即保存私密密钥，之后将无法再次查看。
							</p>
							<ApiKeyDisplay label="公钥" value={keys.publicKey} />
							<ApiKeyDisplay
								label="私密密钥"
								value={keys.secretKey}
								sensitive
							/>
						</div>
						<DialogFooter>
							<Button variant="dark" size="sm" onClick={handleClose}>
								完成
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
