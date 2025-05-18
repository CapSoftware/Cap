import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
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
import { shareCap } from "@/actions/caps/share";

interface SharingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  capId: string;
  capName: string;
  sharedSpaces?: {
    id: string;
    name: string;
    iconUrl?: string | null;
    organizationId: string;
  }[];
  userSpaces?: {
    id: string;
    name: string;
    iconUrl?: string | null;
    organizationId: string;
  }[];
  onSharingUpdated: (updatedSharedSpaces: string[]) => void;
}

export const SharingDialog: React.FC<SharingDialogProps> = ({
  isOpen,
  onClose,
  capId,
  capName,
  onSharingUpdated,
}) => {
  const { spacesData, sharedSpaces } = useSharedContext();

  const [selectedSpaces, setSelectedSpaces] = useState<Set<string>>(
    new Set(sharedSpaces?.map((space) => space.id) || [])
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [initialSelectedSpaces, setInitialSelectedSpaces] = useState<
    Set<string>
  >(new Set(sharedSpaces?.map((space) => space.id) || []));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      const currentSpaceIds = new Set(
        sharedSpaces?.map((space) => space.id) || []
      );
      setSelectedSpaces(currentSpaceIds);
      setInitialSelectedSpaces(currentSpaceIds);
      setSearchTerm("");
    }
  }, [isOpen, sharedSpaces]);

  const handleToggleSpace = (spaceId: string) => {
    console.log(`Toggling space: ${spaceId}`);
    setSelectedSpaces((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(spaceId)) {
        console.log(`Removing space ${spaceId} from selection`);
        newSet.delete(spaceId);
      } else {
        console.log(`Adding space ${spaceId} to selection`);
        newSet.add(spaceId);
      }
      return newSet;
    });
  };

  const handleSave = async () => {
    try {
      console.log("Starting save operation for cap:", capId);
      console.log("Selected spaces:", Array.from(selectedSpaces));
      setLoading(true);
      const result = await shareCap({
        capId,
        spaceIds: Array.from(selectedSpaces),
      });

      if (!result.success) {
        console.error("Share operation failed:", result.error);
        throw new Error(result.error || "Failed to update sharing settings");
      }

      const newSelectedSpaces = Array.from(selectedSpaces);
      const initialSpaces = Array.from(initialSelectedSpaces);

      const addedSpaceIds = newSelectedSpaces.filter(
        (id) => !initialSpaces.includes(id)
      );
      const removedSpaceIds = initialSpaces.filter(
        (id) => !newSelectedSpaces.includes(id)
      );

      console.log("Added spaces:", addedSpaceIds);
      console.log("Removed spaces:", removedSpaceIds);

      if (addedSpaceIds.length === 1 && removedSpaceIds.length === 0) {
        const addedSpaceName = sharedSpaces?.find(
          (space) => space.id === addedSpaceIds[0]
        )?.name;
        console.log(`Sharing to single space: ${addedSpaceName}`);
        toast.success(`Shared to ${addedSpaceName}`);
      } else if (removedSpaceIds.length === 1 && addedSpaceIds.length === 0) {
        const removedSpaceName = sharedSpaces?.find(
          (space) => space.id === removedSpaceIds[0]
        )?.name;
        console.log(`Unsharing from single space: ${removedSpaceName}`);
        toast.success(`Unshared from ${removedSpaceName}`);
      } else if (addedSpaceIds.length > 0 && removedSpaceIds.length === 0) {
        console.log(`Sharing to ${addedSpaceIds.length} spaces`);
        toast.success(`Shared to ${addedSpaceIds.length} spaces`);
      } else if (removedSpaceIds.length > 0 && addedSpaceIds.length === 0) {
        console.log(`Unsharing from ${removedSpaceIds.length} spaces`);
        toast.success(`Unshared from ${removedSpaceIds.length} spaces`);
      } else if (addedSpaceIds.length > 0 && removedSpaceIds.length > 0) {
        console.log("Updating sharing settings with multiple changes");
        toast.success(`Sharing settings updated`);
      } else {
        console.log("No changes to sharing settings");
        toast.success("No changes to sharing settings");
      }
      onSharingUpdated(newSelectedSpaces);
      onClose();
    } catch (error) {
      console.error("Error updating sharing settings:", error);
      toast.error("Failed to update sharing settings");
    } finally {
      setLoading(false);
    }
  };

  const filteredSpaces = searchTerm
    ? spacesData?.filter((space) =>
        space.name.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : spacesData;

  console.log(filteredSpaces);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="p-0 w-full max-w-md rounded-xl border bg-gray-2 border-gray-4">
        <DialogHeader
          icon={<FontAwesomeIcon icon={faShareNodes} className="size-3.5" />}
          description="Select the spaces you would like to share with"
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
          <div className="grid grid-cols-4 gap-3 max-h-60 overflow-y-auto">
            {filteredSpaces && filteredSpaces.length > 0 ? (
              filteredSpaces.map((space) => (
                <SpaceCard
                  key={space.id}
                  space={space}
                  selectedSpaces={selectedSpaces}
                  handleToggleSpace={handleToggleSpace}
                />
              ))
            ) : (
              <div className="flex gap-2 justify-center items-center pt-2 text-sm col-span-4">
                <p className="text-gray-12">
                  {spacesData && spacesData.length > 0
                    ? "No spaces match your search"
                    : "No spaces available"}
                </p>
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
  space,
  selectedSpaces,
  handleToggleSpace,
}: {
  space: {
    id: string;
    name: string;
    iconUrl?: string | null;
    organizationId: string;
  };
  selectedSpaces: Set<string>;
  handleToggleSpace: (spaceId: string) => void;
}) => {
  return (
    <Tooltip content={space.name}>
      <div
        className={clsx(
          "flex items-center relative flex-col justify-center gap-2 border transition-colors bg-gray-1 duration-200 border-gray-3 w-full p-3 rounded-xl cursor-pointer",
          selectedSpaces.has(space.id)
            ? "bg-gray-3 border-gray-4"
            : "hover:bg-gray-3 hover:border-gray-4"
        )}
        onClick={() => handleToggleSpace(space.id)}
      >
        {space.iconUrl ? (
          <div className="overflow-hidden relative flex-shrink-0 rounded-full size-6">
            <Image
              src={space.iconUrl}
              alt={space.name}
              width={24}
              height={24}
              className="object-cover w-full h-full"
            />
          </div>
        ) : (
          <Avatar
            letterClass="text-gray-1 text-xs"
            className="relative flex-shrink-0 size-6 z-10"
            name={space.name}
          />
        )}
        <p className="max-w-full text-xs truncate transition-colors duration-200 text-gray-10">
          {space.name}
        </p>
        <motion.div
          key={space.id}
          animate={{
            scale: selectedSpaces.has(space.id) ? 1 : 0,
          }}
          initial={{
            scale: 0,
          }}
          transition={{
            type: selectedSpaces.has(space.id) ? "spring" : "tween",
            stiffness: selectedSpaces.has(space.id) ? 300 : undefined,
            damping: selectedSpaces.has(space.id) ? 20 : undefined,
            duration: !selectedSpaces.has(space.id) ? 0.2 : undefined,
          }}
          className={clsx(
            "absolute top-0 right-0 flex items-center justify-center bg-gray-4 rounded-full border size-5",
            selectedSpaces.has(space.id)
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
