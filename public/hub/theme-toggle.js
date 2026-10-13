// Theme choice (docs/hub-spec.md, section 6): match the system (default),
// light or dark, remembered on this device. theme.js applies it before paint.

const STORAGE_KEY = "hub-theme";
const ORDER = ["system", "light", "dark"];
const NAMES = { system: "match system", light: "light", dark: "dark" };
const systemLight = window.matchMedia("(prefers-color-scheme: light)");

function readChoice() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function saveChoice(choice) {
  try {
    if (choice === "system") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, choice);
    }
  } catch {
    // Storage blocked: the choice lasts until reload.
  }
}

function apply(choice) {
  const light = choice === "light" || (choice === "system" && systemLight.matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";

  // Browser chrome on phones follows the top bar.
  const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", surface);
}

// The button cycles: match system, light, dark.
export function initThemeToggle(button) {
  let choice = readChoice();

  const render = () => {
    const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length];
    button.dataset.choice = choice;
    button.title = `Theme: ${NAMES[choice]}`;
    button.setAttribute("aria-label", `Theme: ${NAMES[choice]}. Switch to ${NAMES[next]}.`);
  };

  button.addEventListener("click", () => {
    choice = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length];
    saveChoice(choice);
    apply(choice);
    render();
  });

  systemLight.addEventListener("change", () => {
    if (choice === "system") {
      apply(choice);
    }
  });

  apply(choice);
  render();
}
