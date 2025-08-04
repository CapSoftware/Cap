import { PropsWithChildren } from "react";
import { Intercom } from "../Layout/Intercom";

export const revalidate = 0;

export default function Layout(props: PropsWithChildren) {
  return (
    <>
      {props.children}
      <Intercom />
    </>
  );
}
