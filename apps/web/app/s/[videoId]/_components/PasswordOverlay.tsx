import { Button, Dialog, DialogContent, Input, Logo } from "@cap/ui";
import { motion } from "framer-motion";
import { useState } from "react";
import { toast } from "sonner";
import { verifyVideoPassword } from "@/actions/videos/password";

interface PasswordOverlayProps {
  isOpen: boolean;
  videoId: string;
  onSuccess: () => void;
}

const MotionDialogContent = motion.create(DialogContent);

export const PasswordOverlay: React.FC<PasswordOverlayProps> = ({
  isOpen,
  videoId,
  onSuccess,
}) => {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoading(true);
      const result = await verifyVideoPassword(videoId, password);
      if (result.success) {
        onSuccess();
      } else {
        toast.error(result.message);
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
        className="w-[90vw] sm:max-w-md p-8 rounded-xl border border-gray-200 bg-white shadow-xl"
      >
        <div className="flex flex-col items-center space-y-6">
          <div className="flex flex-col items-center space-y-4">
            <Logo className="w-24 h-auto" />
            <div className="text-center space-y-2">
              <h2 className="text-xl font-semibold text-gray-12">
                Protected Video
              </h2>
              <p className="text-sm text-gray-10 max-w-sm">
                This video is password protected. Please enter the password to
                continue watching.
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="w-full space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="password"
                className="text-sm font-medium text-gray-12"
              >
                Password
              </label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                className="w-full"
                autoFocus
              />
            </div>
            <Button
              type="submit"
              variant="dark"
              size="lg"
              className="w-full"
              spinner={loading}
              disabled={loading || !password.trim()}
            >
              {loading ? "Verifying..." : "Access Video"}
            </Button>
          </form>
        </div>
      </MotionDialogContent>
    </Dialog>
  );
};
