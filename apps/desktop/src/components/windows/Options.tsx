import { Recorder } from "@/components/windows/inner/Recorder";
import { SignIn } from "@/components/windows/inner/SignIn";
import { supabase } from "@/utils/database/client";
import { openLinkInBrowser, uuidParse } from "@/utils/helpers";
import { useMediaDevices } from "@/utils/recording/MediaDeviceContext";
import { recordingFileLocation } from "@/utils/recording/client";
import { AuthSession } from "@supabase/supabase-js";
import { invoke } from "@tauri-apps/api";
import { UnlistenFn, listen } from "@tauri-apps/api/event";
import { exists } from "@tauri-apps/api/fs";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";

export const Options = () => {
  const [session, setSession] = useState<AuthSession | null>(null);
  const { setIsRecording } = useMediaDevices();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
  }, []);

  useEffect(() => {
    let unlistenFn: UnlistenFn | undefined;

    const setupEventListener = async () => {
      unlistenFn = await listen("video-uploaded", async (event) => {
        console.log("video-uploaded event received:", event);

        if (
          !event.payload ||
          !session?.user?.id ||
          session?.user?.id === null ||
          session?.user?.id === undefined
        ) {
          console.error("Payload is empty, or user is not logged in.");
          setIsRecording(false);
          toast.error("An error occurred while uploading the video.");
          return;
        }

        const filePath = await recordingFileLocation();

        const checkFileExists = async () => {
          const fileExists = await exists(filePath);

          if (!fileExists) {
            console.error("File does not exist.");
            setTimeout(checkFileExists, 100);
          }

          console.log("Calling upload_video for the final time...");

          if (
            fileExists &&
            session?.user?.id !== undefined &&
            session?.user?.id !== null
          ) {
            await invoke("upload_video", {
              userId: session.user.id,
              filePath: filePath,
              uniqueId: event.payload,
              finalCall: true,
            });
          }

          const { data, error } = await supabase
            .from("videos")
            .insert([
              { unique_cap_id: event.payload, owner_id: session?.user?.id },
            ]);

          if (error) {
            console.error("Error inserting video:", error);
            toast.error("An error occurred while uploading the video.");
            setIsRecording(false);
          } else {
            console.log("Video inserted:", data);

            if (data) {
              console.log(
                "Opening link in browser: ",
                `https://cap.so/share/${uuidParse(event.payload as string)}`
              );

              openLinkInBrowser(
                `https://cap.so/share/${uuidParse(event.payload as string)}`
              );
            }

            setIsRecording(false);
          }
        };

        checkFileExists();
      });
    };

    setupEventListener();

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, []);

  if (session?.user?.id) {
    console.log("session?.user?.id: ", session?.user?.id);
    return <Recorder session={session} />;
  }

  return <SignIn />;
};
