// Sets the theme before the page paints, so it never flashes the wrong one.
// Loaded as a plain (blocking) script; app.js handles the toggle afterwards.
(function () {
  var choice = null;

  try {
    choice = localStorage.getItem("hub-theme");
  } catch (error) {
    // Storage blocked: follow the system setting.
  }

  var light = choice === "light"
    || (choice !== "dark" && window.matchMedia("(prefers-color-scheme: light)").matches);

  document.documentElement.dataset.theme = light ? "light" : "dark";
})();
