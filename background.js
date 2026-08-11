import { lang } from "./modules/localizator";

chrome.runtime.onInstalled.addListener(() => {
  console.log("Background is activated.");
  lang();
});