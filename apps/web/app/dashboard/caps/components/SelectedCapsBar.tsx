"use client";

import { Button } from "@cap/ui";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import NumberFlow from "@number-flow/react";
import { AnimatePresence, motion } from "framer-motion";

interface SelectedCapsBarProps {
  selectedCaps: string[];
  setSelectedCaps: (caps: string[]) => void;
  deleteSelectedCaps: () => void;
  isDeleting: boolean;
}

export const SelectedCapsBar = ({
  selectedCaps,
  setSelectedCaps,
  deleteSelectedCaps,
  isDeleting
}: SelectedCapsBarProps) => {
  return (
    <AnimatePresence>
      {selectedCaps.length > 0 && (
        <motion.div
          className="flex fixed right-0 left-0 bottom-4 z-50 justify-between items-center p-3 mx-auto w-full max-w-xl rounded-xl border shadow-lg border-gray-2 bg-gray-1"
          initial={{ opacity: 0, y: 10, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{
            opacity: 0,
            y: 10,
            scale: 0.9,
            transition: { duration: 0.2 },
          }}
          transition={{
            opacity: { duration: 0.3, ease: "easeOut" },
            y: { type: "spring", damping: 15, stiffness: 200 },
            scale: { type: "spring", damping: 15, stiffness: 200 }
          }}
        >
          <div className="flex gap-1 text-sm font-medium text-gray-10">
            <NumberFlow
              value={selectedCaps.length}
              className="tabular-nums text-md text-gray-12"
            />
            cap{selectedCaps.length !== 1 ? "s" : ""} selected
          </div>
          <div className="flex gap-2 ml-4">
            <Button
              variant="dark"
              onClick={() => setSelectedCaps([])}
              className="text-sm"
              size="sm"
            >
              Cancel
            </Button>
            <Button
              style={{ minWidth: "auto" }}
              variant="destructive"
              onClick={deleteSelectedCaps}
              disabled={isDeleting}
              className="text-sm w-[40px]"
              spinner={isDeleting}
              size="sm"
            >
              <FontAwesomeIcon className="text-white size-3.5" icon={faTrash} />
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
