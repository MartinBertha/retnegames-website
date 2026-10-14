(() => {
  "use strict";

  const form = document.getElementById("contact-form");
  const submitButton = document.getElementById("submit-button");
  const status = document.getElementById("form-status");
  const year = document.getElementById("copyright-year");

  year.textContent = new Date().getFullYear();

  const navToggle = document.querySelector(".nav-toggle");
  const siteNav = document.getElementById("site-nav");

  const setNav = (open) => {
    siteNav.classList.toggle("open", open);
    navToggle.setAttribute("aria-expanded", String(open));
  };

  navToggle.addEventListener("click", () => {
    setNav(navToggle.getAttribute("aria-expanded") !== "true");
  });

  siteNav.addEventListener("click", (event) => {
    if (event.target.closest("a")) setNav(false);
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".site-header")) setNav(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setNav(false);
      navToggle.focus();
    }
  });

  window.matchMedia("(min-width: 681px)").addEventListener("change", () => setNav(false));

  if (!form) return;

  const setStatus = (message, type = "") => {
    status.textContent = message;
    status.className = `form-status${type ? ` ${type}` : ""}`;
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!form.reportValidity()) return;

    const turnstileToken = form.querySelector("[name='cf-turnstile-response']")?.value;

    if (!turnstileToken) {
      setStatus("Still verifying — please try again in a moment.", "error");
      return;
    }

    const payload = {
      email: form.email.value.trim(),
      subject: form.subject.value.trim(),
      message: form.message.value.trim(),
      website: form.website.value.trim(),
      turnstileToken
    };

    submitButton.disabled = true;
    setStatus("Sending…");

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || "Something went wrong. Please try again.");
      }

      form.reset();

      if (window.turnstile) {
        window.turnstile.reset();
      }

      setStatus("Thanks — your message has been sent.", "success");
    } catch (error) {
      setStatus(error.message || "Something went wrong. Please try again.", "error");

      if (window.turnstile) {
        window.turnstile.reset();
      }
    } finally {
      submitButton.disabled = false;
    }
  });
})();
