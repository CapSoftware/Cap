import { PropsWithChildren } from "react";
import { Footer } from "./Footer";
import { Navbar } from "./Navbar";

export default function Layout(props: PropsWithChildren) {
  return (
    <>
      <Navbar />
      {props.children}
      <Footer />
    </>
  );
}
