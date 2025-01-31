import logo from "@assets/img/logo.svg";
import "@src/styles/index.css";
import styles from "./Newtab.module.css";

const Newtab = () => {
  return (
    <div class={styles.App}>
      <header class={styles.header}>
        <img src={logo} class={styles.logo} alt="logo" />
        <p class="font-bold">
          Edit <code>src/pages/newtab/Newtab.tsx</code> and save to reload.
        </p>
        <a
          class={styles.link}
          href="https://github.com/solidjs/solid"
          target="_blank"
          rel="noopener noreferrer"
        >
          Learn Solid
        </a>
      </header>
    </div>
  );
};

export default Newtab;
