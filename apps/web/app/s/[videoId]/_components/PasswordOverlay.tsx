import { Button, Dialog, DialogContent, Input } from "@cap/ui";
import { motion } from "framer-motion";
import { useState } from "react";
import { toast } from "sonner";

interface PasswordOverlayProps {
  isOpen: boolean;
  videoId: string;
  onSuccess: () => void;
}

const MotionDialogContent = motion.create(DialogContent);

export const PasswordOverlay: React.FC<PasswordOverlayProps> = ({ isOpen, videoId, onSuccess }) => {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoading(true);
      const res = await fetch("/api/video/password/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, password }),
      });
      if (res.ok) {
        onSuccess();
      } else {
        toast.error("Incorrect password");
      }
    } catch (err) {
      toast.error("Failed to verify password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={() => {}}>
      <MotionDialogContent
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.2 }}
        className="w-[90vw] sm:max-w-sm p-6 rounded-xl"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <p className="text-lg font-medium">Enter password to view this video</p>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          <Button type="submit" variant="dark" spinner={loading} disabled={loading}>
            Submit
          </Button>
        </form>
      </MotionDialogContent>
    </Dialog>
  );
};
