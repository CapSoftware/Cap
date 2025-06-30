import { PropsWithChildren } from "react";
import { Intercom } from "../Layout/Intercom";

export default function Layout(props: PropsWithChildren) {
  return (
    <>
      {props.children}
      <Intercom />
    </>
  );
}
