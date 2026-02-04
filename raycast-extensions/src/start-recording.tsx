import {getApplications, open, showHUD} from "@raycast/api";

export default async function Command(){
     const apps = await getApplications();
  const capInstalled = apps.some(
    (app) => app.bundleId === "so.cap.desktop" || app.bundleId === "so.cap.desktop.dev"
  );

  if (!capInstalled) {
    await showHUD("Cap is not installed");
    return;
  }

  const action = {
    start_recording: { page: "recording" }
  };

  const deeplink = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
  
  try {
    await open(deeplink);
    await showHUD("Opening Cap recording settings...");
  } catch  {
    await showHUD(" Failed to open Cap");
  }
 
}