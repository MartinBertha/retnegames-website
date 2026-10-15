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
    if (event.key === "Escape" && siteNav.classList.contains("open")) {
      setNav(false);
      navToggle.focus();
    }
  });

  window.matchMedia("(min-width: 681px)").addEventListener("change", () => setNav(false));

  // Screenshot gallery
  const lightbox = document.getElementById("lightbox");
  const shots = [...document.querySelectorAll("[data-gallery]")];

  if (lightbox && shots.length) {
    const lbImg = lightbox.querySelector(".lb-img");
    const lbCount = lightbox.querySelector(".lb-count");
    let index = 0;

    const show = (i) => {
      index = (i + shots.length) % shots.length;
      const link = shots[index];
      lbImg.src = link.href;
      lbImg.alt = link.querySelector("img").alt;
      lbCount.textContent = `${index + 1} / ${shots.length}`;
    };

    shots.forEach((link, i) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        show(i);
        document.documentElement.classList.add("lightbox-open");
        lightbox.showModal();
      });
    });

    lightbox.querySelector(".lb-prev").addEventListener("click", () => show(index - 1));
    lightbox.querySelector(".lb-next").addEventListener("click", () => show(index + 1));
    lightbox.querySelector(".lb-close").addEventListener("click", () => lightbox.close());

    // A click on the empty area around the image closes the gallery.
    lightbox.addEventListener("click", (event) => {
      if (event.target === lightbox) lightbox.close();
    });

    lightbox.addEventListener("close", () => {
      document.documentElement.classList.remove("lightbox-open");
    });

    lightbox.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") show(index - 1);
      if (event.key === "ArrowRight") show(index + 1);
    });

    let touchX = null;

    lightbox.addEventListener("touchstart", (event) => {
      touchX = event.touches[0].clientX;
    }, { passive: true });

    lightbox.addEventListener("touchend", (event) => {
      if (touchX === null) return;
      const dx = event.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(dx) > 50) show(index + (dx < 0 ? 1 : -1));
    });
  }

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
