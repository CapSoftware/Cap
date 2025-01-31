import { render } from "solid-js/web";
import "./index.css";
import Newtab from "./Newtab";

const appContainer = document.querySelector("#app-container");
if (!appContainer) {
  throw new Error("Can not find AppContainer");
}

render(Newtab, appContainer);
