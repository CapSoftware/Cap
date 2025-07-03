import { createEventListenerMap } from "@solid-primitives/event-listener";
import { createSignal, onMount, Switch, Match, type JSX } from "solid-js";

export default function AltSwitch(props: {
  normal: JSX.Element;
  alt: JSX.Element;
}) {
  const [alt, setAlt] = createSignal(false);

  onMount(() =>
    createEventListenerMap(document, {
      keydown: (e) => setAlt(e.key === "Alt"),
      keyup: (e) => {
        if (e.key === "Alt") setAlt(false);
      },
    })
  );

  return (
    <Switch>
      <Match when={!alt()}>{props.normal}</Match>
      <Match when={alt()}>{props.alt}</Match>
    </Switch>
  );
}
