import logo from "@src/assets/img/logo.svg";
import "@src/styles/index.css";
import styles from "./App.module.css";

const App = () => {
  return (
    <div class="fixed right-5 top-20 z-[2000] w-80 rounded-xl bg-white">
      <div class={styles.App}>
        <header class={styles.header}>
          <img
            src={chrome.runtime.getURL(logo)}
            class={styles.logo}
            alt="logo"
          />
          <p class="flex flex-wrap font-bold">
            Edit <code>src/pages/content/index.tsx</code> and save to reload.
          </p>
          <a
            href="https://github.com/solidjs/solid"
            target="_blank"
            rel="noopener noreferrer"
          >
            Learn Solid
          </a>
        </header>
      </div>
    </div>
  );
};

export default App;
