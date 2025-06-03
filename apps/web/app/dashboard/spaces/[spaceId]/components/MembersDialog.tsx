import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@cap/ui";
import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";

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
                <Avatar
                  letterClass="text-md"
                  name={member.user?.name || "User"}
                  className="size-8 text-gray-12 mr-3"
                />
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-gray-12">
                    {member.user?.name || "User"}
                  </span>
                  <span className="text-xs text-gray-11">
                    {member.user?.email || ""}
                  </span>
                </div>
                {member.role === "ADMIN" && (
                  <span className="ml-auto text-xs font-medium px-2 py-0.5 rounded-full bg-gray-4 text-gray-11">
                    Admin
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
