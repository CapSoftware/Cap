import { Metadata } from "next";
import { SpaceView } from "./SpaceView";

export const metadata: Metadata = {
  title: "Space | Cap",
  description: "View space and its caps",
};

export default function SpacePage({ params }: { params: { spaceId: string } }) {
  return <SpaceView spaceId={params.spaceId} />;
}
