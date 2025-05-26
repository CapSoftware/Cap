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
import { faLock } from "@fortawesome/free-solid-svg-icons";
import { useState } from "react";
import { toast } from "sonner";

interface PasswordDialogProps {
  isOpen: boolean;
  onClose: () => void;
  videoId: string;
  hasPassword: boolean;
  onPasswordUpdated: (protectedStatus: boolean) => void;
}

export const PasswordDialog: React.FC<PasswordDialogProps> = ({
  isOpen,
  onClose,
  videoId,
  hasPassword,
  onPasswordUpdated,
}) => {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/video/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, password }),
      });
      if (!res.ok) throw new Error("Failed");
      toast.success("Password updated");
      onPasswordUpdated(true);
      onClose();
    } catch (err) {
      toast.error("Failed to update password");
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/video/password?videoId=${videoId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed");
      toast.success("Password removed");
      onPasswordUpdated(false);
      onClose();
    } catch (err) {
      toast.error("Failed to remove password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="p-0 w-full max-w-sm rounded-xl border bg-gray-2 border-gray-4">
        <DialogHeader
          icon={<FontAwesomeIcon icon={faLock} className="size-3.5" />}
          description="Restrict access to this video with a password"
        >
          <DialogTitle>Password Protection</DialogTitle>
        </DialogHeader>
        <div className="p-5 space-y-4">
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <DialogFooter className="p-5 border-t border-gray-4">
          <Button size="sm" variant="gray" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          {hasPassword && (
            <Button
              size="sm"
              variant="gray"
              onClick={handleRemove}
              disabled={loading}
            >
              Remove
            </Button>
          )}
          <Button
            size="sm"
            variant="dark"
            onClick={handleSave}
            spinner={loading}
            disabled={loading}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
