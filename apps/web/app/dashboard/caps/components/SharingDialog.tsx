import { useState, useEffect } from "react";
import { Dialog } from "@headlessui/react";
import { toast } from "react-hot-toast";
import { Search, Plus } from "lucide-react";
import { Button } from "@cap/ui";

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
    <Dialog open={isOpen} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <Dialog.Panel className="w-full max-w-md rounded-lg bg-white p-6">
          <Dialog.Title className="text-xl font-semibold mb-4">
            Share {capName} to Spaces
          </Dialog.Title>
          <div className="relative mb-4">
            <input
              type="text"
              placeholder="Search"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <Search
              className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"
              size={20}
            />
          </div>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {filteredSpaces.map((space) => (
              <div
                key={space.id}
                className={`flex items-center justify-between p-3 rounded-lg cursor-pointer ${
                  selectedSpaces.has(space.id)
                    ? "bg-gray-200"
                    : "hover:bg-gray-100"
                }`}
                onClick={() => handleToggleSpace(space.id)}
              >
                <div className="flex items-center">
                  <div className="w-8 h-8 bg-blue-500 rounded-md flex items-center justify-center text-white font-semibold mr-3">
                    {space.name.charAt(0).toUpperCase()}
                  </div>
                  <span className="text-sm font-medium">{space.name}</span>
                </div>
                {selectedSpaces.has(space.id) ? (
                  <span className="text-blue-500 font-medium text-sm">
                    Added
                  </span>
                ) : (
                  <Plus className="text-gray-400" size={20} />
                )}
              </div>
            ))}
          </div>
          <div className="mt-6 flex justify-end space-x-2">
            <Button size="sm" variant="gray" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={handleSave}>
              Share
            </Button>
          </div>
        </Dialog.Panel>
      </div>
    </Dialog>
  );
};
