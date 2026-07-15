import { Button, Label } from "@cap/ui";
import type { Organisation } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { updateOrganizationDetails } from "@/actions/organization/update-details";
import { useDashboardContext } from "../../../Contexts";

export const AccessEmailDomain = () => {
	const { activeOrganization } = useDashboardContext();
	const [emailDomain, setEmailDomain] = useState(
		activeOrganization?.organization.allowedEmailDomain || null,
	);
	const [saveLoading, setSaveLoading] = useState(false);
	const router = useRouter();

	const handleEmailDomainSave = async () => {
		try {
			setSaveLoading(true);
			await updateOrganizationDetails({
				allowedEmailDomain: emailDomain,
				organizationId: activeOrganization?.organization
					.id as Organisation.OrganisationId,
			});
			toast.success("设置已更新");
			router.refresh();
		} catch (error) {
			console.error("Error updating settings:", error);
			toast.error("更新设置时发生错误");
		} finally {
			setSaveLoading(false);
		}
	};

	return (
		<div className="flex-1 space-y-4">
			<div className="space-y-1">
				<Label htmlFor="allowedEmailDomain">邮箱访问限制</Label>
				<p className="text-sm text-gray-10">
					限制可访问“任何获得链接的人”公开视频的用户。添加邮箱域名（例如{" "}
					<code className="text-xs bg-gray-3 px-1 py-0.5 rounded">
						company.com
					</code>
					）或指定邮箱地址（例如{" "}
					<code className="text-xs bg-gray-3 px-1 py-0.5 rounded">
						larry@google.com
					</code>
					），多个值请用逗号分隔。
				</p>
				<p className="text-sm text-gray-10">
					无论此项如何设置，组织和空间成员始终可以访问与他们共享的视频。{" "}
					<span className="font-medium text-gray-11">
						留空则允许任何获得链接的人访问。
					</span>
				</p>
			</div>
			<div className="flex flex-col gap-3 w-full h-fit">
				<textarea
					className="flex px-4 py-3 w-full font-thin transition-all duration-200 text-[16px] md:text-[13px] text-gray-12 bg-gray-1 border-gray-4 outline-0 focus:bg-gray-2 rounded-xl hover:bg-gray-2 border-[1px] focus:border-gray-5 placeholder:text-gray-8 ring-0 ring-gray-2 focus:ring-1 focus:ring-gray-12 focus:ring-offset-2 ring-offset-gray-3 hover:placeholder:text-gray-12 placeholder:duration-200 min-h-[72px] resize-y"
					placeholder="例如 company.com、partner.org、larry@google.com"
					value={emailDomain || ""}
					id="allowedEmailDomain"
					name="allowedEmailDomain"
					onChange={(e) => {
						setEmailDomain(e.target.value);
					}}
				/>
				<div>
					<Button
						className="min-w-fit"
						type="submit"
						spinner={saveLoading}
						size="sm"
						variant="dark"
						disabled={
							saveLoading ||
							emailDomain ===
								activeOrganization?.organization.allowedEmailDomain
						}
						onClick={handleEmailDomainSave}
					>
						{saveLoading ? null : "保存"}
					</Button>
				</div>
			</div>
		</div>
	);
};

export default AccessEmailDomain;
