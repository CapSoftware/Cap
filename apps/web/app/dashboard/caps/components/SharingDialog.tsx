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
  userSpaces: { id: string; name: string }[];
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

  useEffect(() => {
    if (isOpen) {
      setSelectedSpaces(new Set(sharedSpaces.map((space) => space.id)));
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

      toast.success("Sharing settings updated successfully");
      onSharingUpdated(Array.from(selectedSpaces));
      onClose();
    } catch (error) {
      console.error("Error updating sharing settings:", error);
      toast.error("Failed to update sharing settings");
    }
  };

  const filteredSpaces = userSpaces.filter((space) =>
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
          className="fixed inset-0 bg-black/30"
        />
        <Transition.Child
          enter="ease-out duration-300"
          enterFrom="opacity-0 scale-95"
          enterTo="opacity-100 scale-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100 scale-100"
          leaveTo="opacity-0 scale-95"
          className="flex fixed inset-0 justify-center items-center p-4"
        >
          <Dialog.Panel className="w-full max-w-md bg-white rounded-xl">
            <Dialog.Title className="p-5 font-semibold border-b flex items-center gap-3 border-gray-200 text-[16px]">
              <div className="flex justify-center items-center bg-gray-100 rounded-full border border-gray-200 size-10">
                <FontAwesomeIcon
                  className="text-gray-400 size-3"
                  icon={faShareNodes}
                />
              </div>
              <div className="flex flex-col">
                <p className="text-gray-500 text-md">
                  Share{" "}
                  <span className="font-bold text-gray-500">{capName}</span>
                </p>
                <p className="text-sm text-gray-400">
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
                  className="absolute right-3 top-1/2 text-gray-400 transform -translate-y-1/2"
                  size={20}
                />
              </div>
              <div className="overflow-y-auto max-h-60">
                {filteredSpaces.length > 0 ? (
                  filteredSpaces.map((space) => (
                    <div
                      key={space.id}
                      className={clsx(
                        `flex items-center border group transition-colors duration-300 border-gray-200 justify-between p-3 rounded-2xl cursor-pointer`,
                        selectedSpaces.has(space.id)
                          ? "bg-gray-100"
                          : "hover:bg-gray-100"
                      )}
                      onClick={() => handleToggleSpace(space.id)}
                    >
                      <div className="flex items-center">
                        <div className="flex justify-center items-center mr-3 w-8 h-8 font-semibold text-white bg-blue-500 rounded-md">
                          {space.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-sm transition-colors duration-300 group-hover:text-gray-500">
                          {space.name}
                        </span>
                      </div>
                      {selectedSpaces.has(space.id) ? (
                        <span className="text-sm font-medium text-blue-500">
                          Added
                        </span>
                      ) : (
                        <Plus className="text-gray-400" size={20} />
                      )}
                    </div>
                  ))
                ) : (
                  <div className="flex gap-2 justify-center items-center pt-2 text-sm">
                    <p className="font-medium text-gray-500">No spaces found</p>
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end p-5 space-x-2 border-t border-gray-200">
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
