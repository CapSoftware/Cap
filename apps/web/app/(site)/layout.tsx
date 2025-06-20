import { Footer } from "./Footer";
import { Navbar } from "./Navbar";
import { PropsWithChildren } from "react";

export default function Layout(props: PropsWithChildren) {
  return (
    <>
      <Navbar />
      {props.children}
      <Footer />
    </>
  );
}
