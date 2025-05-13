import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";
import { Tooltip } from "@/components/Tooltip";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@cap/ui";
import { faShareNodes } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { motion } from "framer-motion";
import { Check, Search } from "lucide-react";
import Image from "next/image";
import { useEffect, useState } from "react";
import { toast } from "sonner";

interface SharingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  capId: string;
  capName: string;
  sharedOrganizations: { id: string; name: string; iconUrl?: string }[];
  userOrganizations?: { id: string; name: string; iconUrl?: string }[];
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
  const [loading, setLoading] = useState(false);

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
      setLoading(true);
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
    } finally {
      setLoading(false);
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
          <div className="grid grid-cols-4 gap-3 max-h-60">
            {filteredOrganizations && filteredOrganizations.length > 0 ? (
              filteredOrganizations.map((organization) => (
                <SpaceCard
                  key={organization.id}
                  organization={organization}
                  selectedOrganizations={selectedOrganizations}
                  handleToggleOrganization={handleToggleOrganization}
                />
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
          <Button
            spinner={loading}
            disabled={loading}
            size="sm"
            variant="dark"
            onClick={handleSave}
          >
            {loading ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const SpaceCard = ({
  organization,
  selectedOrganizations,
  handleToggleOrganization,
}: {
  organization: { id: string; name: string; iconUrl?: string };
  selectedOrganizations: Set<string>;
  handleToggleOrganization: (organizationId: string) => void;
}) => {
  return (
    <Tooltip content={organization.name}>
    <div
      className={clsx(
        "flex items-center relative flex-col justify-center gap-2 border transition-colors bg-gray-1 duration-200 border-gray-3 w-full p-3 rounded-xl cursor-pointer",
        selectedOrganizations.has(organization.id)
          ? "bg-gray-3 border-gray-4"
          : "hover:bg-gray-3 hover:border-gray-4"
      )}
      onClick={() => handleToggleOrganization(organization.id)}
    >
      {organization.iconUrl ? (
        <div className="overflow-hidden relative flex-shrink-0 rounded-full size-6">
          <Image
            src={organization.iconUrl}
            alt={organization.name}
            width={24}
            height={24}
            className="object-cover w-full h-full"
          />
        </div>
      ) : (
        <Avatar
          letterClass="text-gray-1 text-xs"
          className="relative flex-shrink-0 size-6"
          name={organization.name}
        />
      )}
        <p className="max-w-full text-xs truncate transition-colors duration-200 text-gray-10">
          {organization.name}
        </p>
      <motion.div
        key={organization.id}
        animate={{
          scale: selectedOrganizations.has(organization.id) ? 1 : 0,
        }}
        initial={{
          scale: 0,
        }}
        transition={{
          type: selectedOrganizations.has(organization.id) ? "spring" : "tween",
          stiffness: selectedOrganizations.has(organization.id)
            ? 300
            : undefined,
          damping: selectedOrganizations.has(organization.id) ? 20 : undefined,
          duration: !selectedOrganizations.has(organization.id)
            ? 0.2
            : undefined,
        }}
        className={clsx(
          "absolute top-[-6px] flex items-center justify-center right-[-5px] bg-gray-4 rounded-full border size-4",
          selectedOrganizations.has(organization.id)
            ? "bg-green-500 border-transparent"
            : "bg-gray-4 border-gray-5"
        )}
      >
        <Check className="text-white" size={10} />
      </motion.div>
    </div>
    </Tooltip>
  );
};
