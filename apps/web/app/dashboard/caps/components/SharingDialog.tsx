import { Button, Input } from "@cap/ui";
import { faShareNodes } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Dialog, Transition } from "@headlessui/react";
import clsx from "clsx";
import { Plus, Search } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { toast } from "react-hot-toast";

interface SharingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  capId: string;
  capName: string;
  sharedSpaces: { id: string; name: string }[];
  userSpaces?: { id: string; name: string }[];
  onSharingUpdated: (updatedSharedSpaces: string[]) => void;
}

export const SharingDialog: React.FC<SharingDialogProps> = ({
  isOpen,
  onClose,
  capId,
  capName,
  sharedSpaces,
  userSpaces,
  onSharingUpdated,
}) => {
  const [selectedSpaces, setSelectedSpaces] = useState<Set<string>>(
    new Set(sharedSpaces.map((space) => space.id))
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [initialSelectedSpaces, setInitialSelectedSpaces] = useState<
    Set<string>
  >(new Set(sharedSpaces.map((space) => space.id)));

  useEffect(() => {
    if (isOpen) {
      const currentSpaceIds = new Set(sharedSpaces.map((space) => space.id));
      setSelectedSpaces(currentSpaceIds);
      setInitialSelectedSpaces(currentSpaceIds);
      setSearchTerm("");
    }
  }, [isOpen, sharedSpaces]);

  const handleToggleSpace = (spaceId: string) => {
    setSelectedSpaces((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(spaceId)) {
        newSet.delete(spaceId);
      } else {
        newSet.add(spaceId);
      }
      return newSet;
    });
  };

  const handleSave = async () => {
    try {
      const response = await fetch("/api/caps/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capId, spaceIds: Array.from(selectedSpaces) }),
      });

      if (!response.ok) {
        throw new Error("Failed to update sharing settings");
      }

      const newSelectedSpaces = Array.from(selectedSpaces);
      const initialSpaces = Array.from(initialSelectedSpaces);

      const addedSpaceIds = newSelectedSpaces.filter(
        (id) => !initialSpaces.includes(id)
      );
      const removedSpaceIds = initialSpaces.filter(
        (id) => !newSelectedSpaces.includes(id)
      );

      if (addedSpaceIds.length === 1 && removedSpaceIds.length === 0) {
        const addedSpaceName = userSpaces?.find(
          (space) => space.id === addedSpaceIds[0]
        )?.name;
        toast.success(`Shared to ${addedSpaceName}`);
      } else if (removedSpaceIds.length === 1 && addedSpaceIds.length === 0) {
        const removedSpaceName = sharedSpaces.find(
          (space) => space.id === removedSpaceIds[0]
        )?.name;
        toast.success(`Unshared from ${removedSpaceName}`);
      } else if (addedSpaceIds.length > 0 && removedSpaceIds.length === 0) {
        toast.success(`Shared to ${addedSpaceIds.length} spaces`);
      } else if (removedSpaceIds.length > 0 && addedSpaceIds.length === 0) {
        toast.success(`Unshared from ${removedSpaceIds.length} spaces`);
      } else if (addedSpaceIds.length > 0 && removedSpaceIds.length > 0) {
        toast.success(`Sharing settings updated`);
      } else {
        toast.success("No changes to sharing settings");
      }

      onSharingUpdated(newSelectedSpaces);
      onClose();
    } catch (error) {
      console.error("Error updating sharing settings:", error);
      toast.error("Failed to update sharing settings");
    }
  };

  const filteredSpaces = userSpaces?.filter((space) =>
    space.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog
        as="div"
        open={isOpen}
        onClose={onClose}
        className="relative z-50"
      >
        <Transition.Child
          enter="duration-300 ease-out"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="duration-200 ease-in"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
          className="fixed inset-0 bg-black/60"
        />
        <Transition.Child
          enter="ease-out duration-300"
          enterFrom="opacity-0 scale-95"
          enterTo="opacity-100 scale-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100 scale-100"
          leaveTo="opacity-0 scale-95"
          className="flex fixed inset-0 justify-center items-center p-4 bg-gray-1/70"
        >
          <Dialog.Panel className="w-full max-w-md rounded-xl border bg-gray-1 border-gray-2">
            <Dialog.Title className="p-5 font-semibold border-b flex gap-3 border-gray-2 text-[16px]">
              <div className="flex justify-center items-center rounded-full border border-gray-3 bg-gray-2 size-10">
                <FontAwesomeIcon
                  className="text-gray-10 size-3"
                  icon={faShareNodes}
                />
              </div>
              <div className="flex flex-col">
                <p className="text-gray-12 text-md">
                  Share{" "}
                  <span className="font-bold text-gray-12">{capName}</span>
                </p>
                <p className="text-sm text-gray-10">
                  Select the spaces you would like to share with
                </p>
              </div>
            </Dialog.Title>
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
              <div className="overflow-y-auto max-h-60">
                {filteredSpaces && filteredSpaces.length > 0 ? (
                  filteredSpaces.map((space) => (
                    <div
                      key={space.id}
                      className={clsx(
                        `flex items-center border transition-colors duration-200 border-gray-3 justify-between p-3 rounded-xl cursor-pointer`,
                        selectedSpaces.has(space.id)
                          ? "bg-gray-1"
                          : "hover:bg-gray-3 hover:border-gray-4"
                      )}
                      onClick={() => handleToggleSpace(space.id)}
                    >
                      <div className="flex items-center">
                        <div className="flex justify-center items-center mr-3 w-8 h-8 font-semibold rounded-md bg-blue-10 text-gray-12">
                          {space.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-sm transition-colors duration-200 text-gray-12">
                          {space.name}
                        </span>
                      </div>
                      {selectedSpaces.has(space.id) ? (
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
                    <p className="text-gray-12">No spaces found</p>
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end p-5 space-x-2 border-t border-gray-2">
              <Button size="sm" variant="gray" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" variant="dark" onClick={handleSave}>
                Save
              </Button>
            </div>
          </Dialog.Panel>
        </Transition.Child>
      </Dialog>
    </Transition>
  );
};
