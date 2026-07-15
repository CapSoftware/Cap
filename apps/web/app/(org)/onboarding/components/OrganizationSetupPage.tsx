"use client";

import { Button, Input } from "@cap/ui";
import { faImage } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Effect } from "effect";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { startTransition, useRef, useState } from "react";
import { toast } from "sonner";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { Base } from "./Base";

export function OrganizationSetupPage({
	firstName,
}: {
	firstName: string | null | undefined;
}) {
	const [organizationName, setOrganizationName] = useState(
		firstName ? `${firstName}的组织` : "",
	);
	const [selectedFile, setSelectedFile] = useState<File | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const router = useRouter();
	const rpc = useRpcClient();

	const handleFileChange = () => {
		const file = fileInputRef.current?.files?.[0];
		if (file) {
			setSelectedFile(file);
		}
	};

	const orgSetupMutation = useEffectMutation({
		mutationFn: (data: { organizationName: string; icon?: File }) =>
			Effect.gen(function* () {
				let organizationIcon:
					| {
							data: Uint8Array;
							contentType: string;
							fileName: string;
					  }
					| undefined;

				if (data.icon) {
					const icon = data.icon;
					const arrayBuffer = yield* Effect.promise(() => icon.arrayBuffer());
					organizationIcon = {
						data: new Uint8Array(arrayBuffer),
						contentType: icon.type,
						fileName: icon.name,
					};
				}

				yield* rpc.UserCompleteOnboardingStep({
					step: "organizationSetup",
					data: {
						organizationName: data.organizationName,
						organizationIcon,
					},
				});
			}),
		onSuccess: () => {
			startTransition(() => {
				router.push("/onboarding/custom-domain");
				router.refresh();
			});
		},
		onError: (error) => {
			console.error(error);
			toast.error("发生错误，请重试");
		},
	});

	const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		orgSetupMutation.mutate({
			organizationName,
			icon: selectedFile || undefined,
		});
	};

	return (
		<Base title="设置组织" description="设置你的组织和工作台">
			<form onSubmit={handleSubmit} className="space-y-7">
				<div className="space-y-3">
					<Input
						type="text"
						disabled={orgSetupMutation.isPending}
						value={organizationName}
						onChange={(e) => setOrganizationName(e.target.value)}
						placeholder="组织名称"
						name="organizationName"
						required
					/>
					<div className="rounded-xl border bg-gray-1 h-fit border-gray-4">
						<h3 className="px-3 py-3 text-sm font-medium border-b border-gray-4 text-gray-12">
							组织徽标
						</h3>
						<div className="flex gap-5 p-5">
							<div className="flex justify-center items-center rounded-full border border-dashed size-14 bg-gray-3 border-gray-6">
								{selectedFile ? (
									<Image
										src={URL.createObjectURL(selectedFile)}
										alt="已选择的文件"
										width={56}
										className="object-cover rounded-full size-14"
										height={56}
									/>
								) : (
									<FontAwesomeIcon
										icon={faImage}
										className="size-4 text-gray-9"
									/>
								)}
							</div>
							<input
								type="file"
								className="hidden h-0"
								accept="image/jpeg, image/jpg, image/png, image/svg+xml"
								ref={fileInputRef}
								onChange={handleFileChange}
							/>
							<div className="space-y-3">
								<Button
									type="button"
									variant="gray"
									disabled={orgSetupMutation.isPending}
									size="xs"
									onClick={() => fileInputRef.current?.click()}
								>
									上传图片
								</Button>
								<p className="text-xs text-gray-10">建议尺寸：120 × 120</p>
							</div>
						</div>
					</div>
				</div>
				<div className="w-full h-px bg-gray-4" />
				<Button
					type="submit"
					variant="dark"
					className="mx-auto w-full"
					spinner={orgSetupMutation.isPending}
					disabled={orgSetupMutation.isPending}
				>
					创建组织
				</Button>
			</form>
		</Base>
	);
}
