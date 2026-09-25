const ALLOWED_ORIGINS = new Set([
  "https://retne.games",
  "https://www.retne.games",
  "http://localhost:8787",
  "http://127.0.0.1:8787"
]);

const EMAIL_ADDRESS = "hello@retne.games";
const MAX_BODY_BYTES = 12_000;
const MAX_SUBJECT_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 5_000;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function json(data, status = 200, origin = "") {
  const headers = new Headers(JSON_HEADERS);

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }

  return new Response(JSON.stringify(data), { status, headers });
}

function validEmail(value) {
  return typeof value === "string"
    && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function cleanHeaderText(value) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

async function verifyTurnstile(token, secret, ip, expectedHostname) {
  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret,
        response: token,
        remoteip: ip
      })
    }
  );

  if (!response.ok) return false;

  const result = await response.json();

  return Boolean(
    result.success
    && (!result.hostname || result.hostname === expectedHostname)
    && (!result.action || result.action === "contact")
  );
}

function securityHeaders(response) {
  const headers = new Headers(response.headers);

  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data:",
      "style-src 'self'",
      "font-src 'self'",
      "script-src 'self' https://challenges.cloudflare.com",
      "frame-src https://challenges.cloudflare.com",
      "connect-src 'self' https://challenges.cloudflare.com",
      "upgrade-insecure-requests"
    ].join("; ")
  );
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (url.pathname === "/api/contact") {
      if (request.method === "OPTIONS") {
        if (!ALLOWED_ORIGINS.has(origin)) {
          return new Response(null, { status: 403 });
        }

        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": origin,
            "access-control-allow-methods": "POST, OPTIONS",
            "access-control-allow-headers": "Content-Type",
            "access-control-max-age": "86400",
            "vary": "Origin"
          }
        });
      }

      if (request.method !== "POST") {
        return json({ error: "Method not allowed." }, 405, origin);
      }

      if (!ALLOWED_ORIGINS.has(origin)) {
        return json({ error: "Forbidden." }, 403);
      }

      const contentLength = Number(request.headers.get("Content-Length") || 0);
      if (contentLength > MAX_BODY_BYTES) {
        return json({ error: "Request too large." }, 413, origin);
      }

      const ip = request.headers.get("CF-Connecting-IP") || "unknown";

      // 3 contact submissions per minute per source IP.
      // This is an abuse-control layer; Turnstile remains mandatory.
      if (env.CONTACT_RATE_LIMITER) {
        const { success } = await env.CONTACT_RATE_LIMITER.limit({
          key: `contact:${ip}`
        });

        if (!success) {
          return json(
            { error: "Too many requests. Please wait a minute and try again." },
            429,
            origin
          );
        }
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid request." }, 400, origin);
      }

      const email = typeof body.email === "string" ? body.email.trim() : "";
      const subject = typeof body.subject === "string"
        ? cleanHeaderText(body.subject)
        : "";
      const message = typeof body.message === "string"
        ? body.message.trim()
        : "";
      const website = typeof body.website === "string" ? body.website.trim() : "";
      const turnstileToken = typeof body.turnstileToken === "string"
        ? body.turnstileToken
        : "";

      // Bots that fill the hidden honeypot receive a generic success response
      // without causing an email to be sent.
      if (website) {
        return json({ success: true }, 200, origin);
      }

      if (
        !validEmail(email)
        || !subject
        || subject.length > MAX_SUBJECT_LENGTH
        || !message
        || message.length > MAX_MESSAGE_LENGTH
        || !turnstileToken
        || turnstileToken.length > 2048
      ) {
        return json({ error: "Please check the form fields and try again." }, 400, origin);
      }

      const hostname = url.hostname;
      const turnstileValid = await verifyTurnstile(
        turnstileToken,
        env.TURNSTILE_SECRET,
        ip,
        hostname
      );

      if (!turnstileValid) {
        return json(
          { error: "Verification failed. Please try again." },
          403,
          origin
        );
      }

      const emailResult = await env.EMAIL.send({
        to: EMAIL_ADDRESS,
        from: EMAIL_ADDRESS,
        replyTo: email,
        subject: `[retne.games] ${subject}`,
        text: [
          `New message from retne.games`,
          ``,
          `From: ${email}`,
          `Subject: ${subject}`,
          ``,
          message,
          ``,
          `---`,
          `Sent via retne.games contact form.`
        ].join("\n")
      });

      if (!emailResult?.messageId) {
        return json(
          { error: "We couldn't send your message. Please try again later." },
          502,
          origin
        );
      }

      return json({ success: true }, 200, origin);
    }

    const response = await env.ASSETS.fetch(request);
    return securityHeaders(response);
  }
};
