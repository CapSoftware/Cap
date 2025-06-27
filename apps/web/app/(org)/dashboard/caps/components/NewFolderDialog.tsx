import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@cap/ui";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faFolderPlus } from "@fortawesome/free-solid-svg-icons";
import React, { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { BlueFolder, NormalFolder, RedFolder, YellowFolder } from "./Folders";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}


const FolderOptions = [
  {
    value: "normal",
    label: "Normal",
    component: <NormalFolder />,
  },
  {
    value: "blue",
    label: "Blue",
    component: <BlueFolder />,
  },
  {
    value: "red",
    label: "Red",
    component: <RedFolder />,
  },
  {
    value: "yellow",
    label: "Yellow",
    component: <YellowFolder />,
  },
] as const;

export const NewFolderDialog: React.FC<Props> = ({ open, onOpenChange }) => {
  const [selectedColor, setSelectedColor] = useState<typeof FolderOptions[number]["value"] | null>(null);
  const folderRefs = useRef<Record<string, any>>({});

  useEffect(() => {
    if (!open) setSelectedColor(null);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader icon={<FontAwesomeIcon icon={faFolderPlus} className="size-3.5" />}>
          <DialogTitle>New Folder</DialogTitle>
        </DialogHeader>
        <div className="p-5">
          <Input placeholder="Folder name" />
          <div className="flex flex-wrap gap-2 mt-3">
            {FolderOptions.map((option) => {
              const folderRef = useRef<any>(null);
              folderRefs.current[option.value] = folderRef;

              return (
                <div
                  className={clsx("flex flex-col flex-1 gap-1 items-center p-2 rounded-xl border transition-colors duration-200 cursor-pointer", selectedColor === option.value ? "border-gray-12 bg-gray-3 hover:bg-gray-3 hover:border-gray-12" : "border-gray-4 hover:bg-gray-3 hover:border-gray-5 bg-transparent")}
                  key={option.value}
                  onClick={() => {
                    if (selectedColor === option.value) {
                      setSelectedColor(null);
                      return;
                    }
                    setSelectedColor(option.value);
                  }}
                  onMouseEnter={() => {
                    const folderRef = folderRefs.current[option.value]?.current;
                    if (!folderRef) return;
                    folderRef.stop();
                    folderRef.play("folder-open");
                  }}
                  onMouseLeave={() => {
                    const folderRef = folderRefs.current[option.value]?.current;
                    if (!folderRef) return;
                    folderRef.stop();
                    folderRef.play("folder-close");
                  }}
                >
                  {React.cloneElement(option.component, { ref: folderRef })}
                  <p className="text-xs text-gray-10">{option.label}</p>
                </div>
              );
            })}
          </div>
        </div>
        <DialogFooter>
          <Button size="sm" variant="gray" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="dark"
            disabled={!selectedColor}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
