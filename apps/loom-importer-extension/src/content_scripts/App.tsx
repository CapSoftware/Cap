import React from "react";
import "./App.css";
import { ImportProvider, useImport } from "../context/ImportContext";
import ImportProgress from "../components/ImportProgress";

const AppContent: React.FC = () => {
  const { importState, processVideos } = useImport();
  const { currentPage } = importState;

  if (currentPage === "other") return null;

  return (
    <div className="App">
      <div className="fixed top-4 right-4 z-[9999]">
        <ImportProgress
          importState={importState}
          processVideos={processVideos}
        />
      </div>
    </div>
  );
};

function App() {
  return (
    <ImportProvider>
      <AppContent />
    </ImportProvider>
  );
}

export default App;
