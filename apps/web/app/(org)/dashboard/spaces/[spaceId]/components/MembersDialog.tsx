import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@cap/ui";
import type { ImageUpload } from "@cap/web-domain";
import { SignedImageUrl } from "@/components/SignedImageUrl";

interface OrganizationMember {
	id: string;
	role: string;
	createdAt: Date;
	updatedAt: Date;
	userId: string;
	organizationId: string;
	user: {
		id: string;
		name: string | null;
		email: string;
		firstName?: string | null;
		lastName?: string | null;
		memberImage?: ImageUpload.ImageUrl | null;
	};
}

export const MembersDialog = ({
	open,
	onOpenChange,
	members,
	organizationName,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	members: OrganizationMember[];
	organizationName: string;
}) => {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{organizationName} Members</DialogTitle>
				</DialogHeader>
				<div className="max-h-[60vh] overflow-auto py-4">
					<div className="flex flex-col gap-2">
						{members.map((member) => (
							<div
								key={member.userId}
								className="flex items-center p-2 rounded-lg hover:bg-gray-3"
							>
								<SignedImageUrl
									image={member.user?.memberImage}
									name={member.user?.name || "User"}
									className="mr-3 size-8"
									letterClass="text-md"
								/>
								<div className="flex flex-col">
									<span className="text-sm font-medium text-gray-12">
										{member.user?.name || "User"}
									</span>
									<span className="text-xs text-gray-11">
										{member.user?.email || ""}
									</span>
								</div>
							</div>
						))}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
};
