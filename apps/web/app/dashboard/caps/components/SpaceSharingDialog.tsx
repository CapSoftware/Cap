import { useState, useEffect } from "react";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@cap/ui";
import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";
import { Check, Plus, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "react-hot-toast";

interface Space {
  id: string;
  name: string;
  organizationId: string;
}

interface SpaceSharingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  capId: string;
  capName: string;
}

export const SpaceSharingDialog = ({
  isOpen,
  onClose,
  capId,
  capName,
}: SpaceSharingDialogProps) => {
  const router = useRouter();
  const { activeOrganization } = useSharedContext();

  const [loading, setLoading] = useState(false);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [selectedSpaces, setSelectedSpaces] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");

  const [newSpaceDialogOpen, setNewSpaceDialogOpen] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState("");
  const [newSpaceDescription, setNewSpaceDescription] = useState("");

  // Fetch spaces - this would be replaced with an actual API call
  useEffect(() => {
    if (isOpen) {
      // Mock data - this would be an API call in production
      const mockSpaces = [
        {
          id: "s1",
          name: "Second Space",
          organizationId: activeOrganization?.organization.id || "",
        },
        {
          id: "m1",
          name: "My Space",
          organizationId: activeOrganization?.organization.id || "",
        },
        {
          id: "c1",
          name: "Cap",
          organizationId: activeOrganization?.organization.id || "",
        },
      ];
      setSpaces(mockSpaces);

      // Reset states when dialog opens
      setSelectedSpaces([]);
      setSearchQuery("");
    }
  }, [isOpen, activeOrganization]);

  const filteredSpaces = spaces.filter((space) =>
    space.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleSpaceToggle = (spaceId: string) => {
    setSelectedSpaces((prev) => {
      if (prev.includes(spaceId)) {
        return prev.filter((id) => id !== spaceId);
      } else {
        return [...prev, spaceId];
      }
    });
  };

  const handleSave = async () => {
    if (selectedSpaces.length === 0) {
      toast.error("Please select at least one space");
      return;
    }

    setLoading(true);
    try {
      // API call would go here to add cap to selected spaces
      // e.g. await addCapToSpaces(capId, selectedSpaces);

      // Mock success
      setTimeout(() => {
        toast.success(`Added ${capName} to ${selectedSpaces.length} space(s)`);
        router.refresh();
        onClose();
        setLoading(false);
      }, 1000);
    } catch (error) {
      setLoading(false);
      toast.error("Failed to add cap to spaces");
    }
  };

  const handleCreateSpace = async () => {
    if (!newSpaceName.trim()) {
      toast.error("Please enter a space name");
      return;
    }

    setLoading(true);
    try {
      // API call would go here to create a new space
      // e.g. const newSpace = await createSpace(newSpaceName, newSpaceDescription);

      // Mock success
      setTimeout(() => {
        // Create fake new space and add to list
        const newSpace = {
          id: `new-${Date.now()}`,
          name: newSpaceName,
          organizationId: activeOrganization?.organization.id || "",
        };

        setSpaces((prev) => [...prev, newSpace]);
        setSelectedSpaces((prev) => [...prev, newSpace.id]);

        // Reset form and close dialog
        setNewSpaceName("");
        setNewSpaceDescription("");
        setNewSpaceDialogOpen(false);
        setLoading(false);

        toast.success(`Created space "${newSpaceName}"`);
      }, 1000);
    } catch (error) {
      setLoading(false);
      toast.error("Failed to create space");
    }
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add to Space</DialogTitle>
            <DialogDescription>
              Select spaces to add "{capName}" to
            </DialogDescription>
          </DialogHeader>

          <div className="flex justify-between items-center mt-4">
            <div className="relative flex-grow">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-8" />
              <input
                type="text"
                placeholder="Search spaces..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded-md border border-gray-4 bg-gray-2 py-2 pl-8 pr-3 text-sm text-gray-12 focus:border-blue-10 focus:outline-none"
              />
            </div>
            <Button
              variant="gray"
              size="sm"
              className="ml-2 flex items-center gap-1"
              onClick={() => setNewSpaceDialogOpen(true)}
            >
              <Plus className="h-4 w-4" />
              New
            </Button>
          </div>

          <div className="mt-4 max-h-60 overflow-y-auto pr-1">
            {filteredSpaces.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-center">
                <p className="text-sm text-gray-10">No spaces found</p>
                <Button
                  variant="secondary"
                  className="mt-2"
                  onClick={() => setNewSpaceDialogOpen(true)}
                >
                  Create a new space
                </Button>
              </div>
            ) : (
              <Command className="rounded-lg border border-gray-4">
                <CommandGroup>
                  {filteredSpaces.map((space) => (
                    <CommandItem
                      key={space.id}
                      onSelect={() => handleSpaceToggle(space.id)}
                      className="flex items-center px-2 py-2 cursor-pointer"
                    >
                      <div className="flex items-center flex-grow">
                        <Avatar
                          letterClass="text-gray-1 text-xs"
                          className="relative flex-shrink-0 size-6 mr-2"
                          name={space.name}
                        />
                        <span className="text-sm font-medium text-gray-12">
                          {space.name}
                        </span>
                      </div>
                      <div
                        className={`flex h-5 w-5 items-center justify-center rounded-sm border ${
                          selectedSpaces.includes(space.id)
                            ? "border-blue-10 bg-blue-10"
                            : "border-gray-6"
                        }`}
                      >
                        {selectedSpaces.includes(space.id) && (
                          <Check className="h-3.5 w-3.5 text-white" />
                        )}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </Command>
            )}
          </div>

          <DialogFooter className="mt-6">
            <Button variant="gray" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={loading || selectedSpaces.length === 0}
            >
              {loading
                ? "Adding..."
                : `Add to ${selectedSpaces.length} space${
                    selectedSpaces.length !== 1 ? "s" : ""
                  }`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create New Space Dialog */}
      <Dialog open={newSpaceDialogOpen} onOpenChange={setNewSpaceDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a new Space</DialogTitle>
            <DialogDescription>
              Spaces allow you to organize your caps and control access within
              your organization.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-4">
            <div>
              <label
                htmlFor="spaceName"
                className="block text-sm font-medium text-gray-12"
              >
                Space Name
              </label>
              <input
                type="text"
                id="spaceName"
                value={newSpaceName}
                onChange={(e) => setNewSpaceName(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-4 bg-gray-2 px-3 py-2 text-gray-12 focus:border-blue-10 focus:outline-none focus:ring-1 focus:ring-blue-10"
                placeholder="Enter space name"
              />
            </div>
            <div>
              <label
                htmlFor="spaceDescription"
                className="block text-sm font-medium text-gray-12"
              >
                Description (optional)
              </label>
              <textarea
                id="spaceDescription"
                rows={3}
                value={newSpaceDescription}
                onChange={(e) => setNewSpaceDescription(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-4 bg-gray-2 px-3 py-2 text-gray-12 focus:border-blue-10 focus:outline-none focus:ring-1 focus:ring-blue-10"
                placeholder="Describe the purpose of this space"
              />
            </div>
          </div>

          <DialogFooter className="mt-6">
            <Button
              variant="gray"
              onClick={() => setNewSpaceDialogOpen(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateSpace}
              disabled={loading || !newSpaceName.trim()}
            >
              {loading ? "Creating..." : "Create Space"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
