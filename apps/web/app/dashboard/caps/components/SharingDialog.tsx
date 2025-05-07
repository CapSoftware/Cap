import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input } from "@cap/ui";
import { faShareNodes } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

interface SharingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  capId: string;
  capName: string;
  sharedOrganizations: { id: string; name: string }[];
  userOrganizations?: { id: string; name: string }[];
  onSharingUpdated: (updatedSharedOrganizations: string[]) => void;
}

export const SharingDialog: React.FC<SharingDialogProps> = ({
  isOpen,
  onClose,
  capId,
  capName,
  sharedOrganizations,
  userOrganizations,
  onSharingUpdated,
}) => {
  const [selectedOrganizations, setSelectedOrganizations] = useState<
    Set<string>
  >(new Set(sharedOrganizations.map((organization) => organization.id)));
  const [searchTerm, setSearchTerm] = useState("");
  const [initialSelectedOrganizations, setInitialSelectedOrganizations] =
    useState<Set<string>>(
      new Set(sharedOrganizations.map((organization) => organization.id))
    );

  useEffect(() => {
    if (isOpen) {
      const currentOrganizationIds = new Set(
        sharedOrganizations.map((organization) => organization.id)
      );
      setSelectedOrganizations(currentOrganizationIds);
      setInitialSelectedOrganizations(currentOrganizationIds);
      setSearchTerm("");
    }
  }, [isOpen, sharedOrganizations]);

  const handleToggleOrganization = (organizationId: string) => {
    setSelectedOrganizations((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(organizationId)) {
        newSet.delete(organizationId);
      } else {
        newSet.add(organizationId);
      }
      return newSet;
    });
  };

  const handleSave = async () => {
    try {
      const response = await fetch("/api/caps/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capId,
          organizationIds: Array.from(selectedOrganizations),
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to update sharing settings");
      }

      const newSelectedOrganizations = Array.from(selectedOrganizations);
      const initialOrganizations = Array.from(initialSelectedOrganizations);

      const addedOrganizationIds = newSelectedOrganizations.filter(
        (id) => !initialOrganizations.includes(id)
      );
      const removedOrganizationIds = initialOrganizations.filter(
        (id) => !newSelectedOrganizations.includes(id)
      );

      if (
        addedOrganizationIds.length === 1 &&
        removedOrganizationIds.length === 0
      ) {
        const addedOrganizationName = userOrganizations?.find(
          (organization) => organization.id === addedOrganizationIds[0]
        )?.name;
        toast.success(`Shared to ${addedOrganizationName}`);
      } else if (
        removedOrganizationIds.length === 1 &&
        addedOrganizationIds.length === 0
      ) {
        const removedOrganizationName = sharedOrganizations.find(
          (organization) => organization.id === removedOrganizationIds[0]
        )?.name;
        toast.success(`Unshared from ${removedOrganizationName}`);
      } else if (
        addedOrganizationIds.length > 0 &&
        removedOrganizationIds.length === 0
      ) {
        toast.success(`Shared to ${addedOrganizationIds.length} organizations`);
      } else if (
        removedOrganizationIds.length > 0 &&
        addedOrganizationIds.length === 0
      ) {
        toast.success(
          `Unshared from ${removedOrganizationIds.length} organizations`
        );
      } else if (
        addedOrganizationIds.length > 0 &&
        removedOrganizationIds.length > 0
      ) {
        toast.success(`Sharing settings updated`);
      } else {
        toast.success("No changes to sharing settings");
      }

      onSharingUpdated(newSelectedOrganizations);
      onClose();
    } catch (error) {
      console.error("Error updating sharing settings:", error);
      toast.error("Failed to update sharing settings");
    }
  };

  const filteredOrganizations = userOrganizations?.filter((organization) =>
    organization.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="p-0 w-full max-w-md rounded-xl border bg-gray-2 border-gray-4">
        <DialogHeader 
          icon={<FontAwesomeIcon icon={faShareNodes} className="size-3.5" />}
          description="Select the organizations you would like to share with"
        >
          <DialogTitle>
            Share <span className="font-bold text-gray-12">{capName}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="p-5">
          <div className="relative mb-4">
            <Input
              type="text"
              placeholder="Search..."
              value={searchTerm}
              className="pr-8"
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <Search
              className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-10"
              size={20}
            />
          </div>
          <div className="flex overflow-y-auto flex-col gap-2.5 max-h-60">
            {filteredOrganizations && filteredOrganizations.length > 0 ? (
              filteredOrganizations.map((organization) => (
                <div
                  key={organization.id}
                  className={clsx(
                    `flex items-center border transition-colors duration-200 border-gray-3 justify-between p-3 rounded-xl cursor-pointer`,
                    selectedOrganizations.has(organization.id)
                      ? "bg-gray-1"
                      : "hover:bg-gray-3 hover:border-gray-4"
                  )}
                  onClick={() => handleToggleOrganization(organization.id)}
                >
                  <div className="flex items-center">
                    <div className="flex justify-center items-center mr-3 w-8 h-8 font-semibold rounded-md bg-blue-10 text-gray-12">
                      {organization.name.charAt(0).toUpperCase()}
                    </div>
                    <span className="text-sm transition-colors duration-200 text-gray-12">
                      {organization.name}
                    </span>
                  </div>
                  {selectedOrganizations.has(organization.id) ? (
                    <span className="text-sm font-medium text-blue-500">
                      Added
                    </span>
                  ) : (
                    <Plus className="text-gray-10" size={20} />
                  )}
                </div>
              ))
            ) : (
              <div className="flex gap-2 justify-center items-center pt-2 text-sm">
                <p className="text-gray-12">No organizations found</p>
              </div>
            )}
          </div>
        </div>
        <DialogFooter className="p-5 border-t border-gray-4">
          <Button size="sm" variant="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="dark" onClick={handleSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
