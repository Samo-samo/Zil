chrome.runtime.onInstalled.addListener(() => {
  console.log("The plugin is successfully installed.");
  
  chrome.alarms.create("checkYouTubeRSS", { periodInMinutes: 15 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "checkYouTubeRSS") {
    checkNewVideos();
  }
});

async function checkNewVideos() {
  console.log("Channels is checking...");
}
