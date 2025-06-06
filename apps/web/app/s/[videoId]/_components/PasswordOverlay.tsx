"use client";

import { Button, Dialog, DialogContent, Input, Logo } from "@cap/ui";
import { useState } from "react";
import { toast } from "sonner";
import { verifyVideoPassword } from "@/actions/videos/password";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

interface PasswordOverlayProps {
  isOpen: boolean;
  videoId: string;
}

export const PasswordOverlay: React.FC<PasswordOverlayProps> = ({
  isOpen,
  videoId,
}) => {
  const [password, setPassword] = useState("");
  const router = useRouter();

  const verifyPassword = useMutation({
    mutationFn: () =>
      verifyVideoPassword(videoId, password).then((v) => {
        if (v.success) return v.value;
        throw new Error(v.error);
      }),
    onSuccess: (result) => {
      toast.success(result);
      router.refresh();
    },
    onError: (e) => {
      toast.error(e.message);
    },
  });

  return (
    <Dialog open={isOpen}>
      <DialogContent className="w-[90vw] sm:max-w-md p-8 rounded-xl border border-gray-200 bg-white shadow-xl">
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

          <div className="w-full space-y-4">
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
              type="button"
              variant="dark"
              size="lg"
              className="w-full"
              spinner={verifyPassword.isPending}
              disabled={verifyPassword.isPending || !password.trim()}
              onClick={() => verifyPassword.mutate()}
            >
              {verifyPassword.isPending ? "Verifying..." : "Access Video"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
