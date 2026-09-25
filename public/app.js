(() => {
  "use strict";

  const form = document.getElementById("contact-form");
  const submitButton = document.getElementById("submit-button");
  const status = document.getElementById("form-status");
  const year = document.getElementById("copyright-year");

  year.textContent = new Date().getFullYear();

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
      setStatus("Please complete the verification before sending.", "error");
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
