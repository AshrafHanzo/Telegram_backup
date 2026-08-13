// Telegram Drive — always-on Temp Link relay.
//
// Runs on Cloudflare's free tier (Workers + KV) so a share link keeps
// working even when the desktop app isn't running / the PC is off. It does
// this by using a Telegram *Bot* (added as an admin to the shared folder and
// to a hidden "relay" channel) instead of the user's own MTProto session,
// since only a bot can be reached from serverless code — grammers/MTProto
// needs a real persistent connection the desktop app already owns.
//
// v1 scope: DOWNLOAD only. Upload/update/delete permissioned links still
// require the desktop app + local tunnel to be running — those operations
// need a much larger relay (accepting file bytes, calling sendDocument,
// etc.) that's deliberately deferred rather than half-built here.
//
// Known hard limit: Telegram's Bot API can only fetch files up to 20MB via
// getFile — this is a Bot API restriction, not something this Worker can
// work around. Larger files only work through the desktop app's own tunnel
// (which uses the user's full MTProto session, no such cap).

import bcrypt from "bcryptjs";

const BOT_API_FILE_SIZE_LIMIT = 20 * 1024 * 1024; // Telegram Bot API's own getFile cap.
const AUTH_TOKEN_TTL_SECONDS = 10 * 60;

// Bit-compatible with desktop's SharePermissions (share_permissions.rs).
const PERMISSIONS = { UPLOAD: 1, DOWNLOAD: 2, UPDATE: 4, DELETE: 8 };

function html(body, status = 200) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Telegram Drive</title>
    <style>
      body{font-family:system-ui,sans-serif;background:#0e1621;color:#e8e8e8;display:flex;min-height:100vh;
        align-items:center;justify-content:center;margin:0;padding:24px;box-sizing:border-box}
      .card{background:#17212b;border-radius:12px;padding:32px;max-width:360px;width:100%}
      h1{font-size:18px;margin:0 0 8px}
      p{font-size:14px;color:#8a97a3;line-height:1.5}
      input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #2b3a49;
        background:#0e1621;color:#e8e8e8;font-size:14px;margin:12px 0}
      button{width:100%;padding:10px 12px;border-radius:8px;border:none;background:#4d9de0;color:#fff;
        font-size:14px;font-weight:600;cursor:pointer}
      .error{color:#f87171;font-size:13px;margin-top:8px}
    </style></head><body><div class="card">${body}</div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function errorPage(title, message, status) {
  return html(`<h1>${title}</h1><p>${message}</p>`, status);
}

async function loadShare(env, token) {
  const raw = await env.SHARES.get(`share:${token}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveShare(env, token, record) {
  await env.SHARES.put(`share:${token}`, JSON.stringify(record));
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToHex(signature);
}

// Short-lived signed token so a correct password doesn't need to be
// re-submitted on every request within the same browsing session.
async function makeAuthToken(env, token) {
  const expiresAt = Math.floor(Date.now() / 1000) + AUTH_TOKEN_TTL_SECONDS;
  const payload = `${token}.${expiresAt}`;
  const signature = await hmacSign(env.AUTH_SECRET, payload);
  return btoa(`${payload}.${signature}`);
}

// Constant-time comparison for secret-derived strings (HMAC signatures,
// admin tokens) — a plain `===`/`!==` short-circuits on the first differing
// byte, which is a real (if hard to exploit over the network) timing oracle
// for guessing a secret one byte at a time. Length itself isn't secret
// here, so an early return on length mismatch doesn't leak anything a
// constant-time-over-equal-lengths compare wouldn't already reveal.
function timingSafeEqual(a, b) {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

async function verifyAuthToken(env, token, authParam) {
  if (!authParam) return false;
  try {
    const [t, expiresAtStr, signature] = atob(authParam).split(".");
    if (!timingSafeEqual(t, token)) return false;
    const expiresAt = Number(expiresAtStr);
    if (!Number.isFinite(expiresAt) || Math.floor(Date.now() / 1000) > expiresAt) return false;
    const expected = await hmacSign(env.AUTH_SECRET, `${t}.${expiresAtStr}`);
    return timingSafeEqual(expected, signature);
  } catch {
    return false;
  }
}

async function telegramApi(botToken, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.description || response.status}`);
  }
  return data.result;
}

function extractFile(message) {
  if (message.document) {
    return { fileId: message.document.file_id, size: message.document.file_size, name: message.document.file_name };
  }
  if (message.video) {
    return { fileId: message.video.file_id, size: message.video.file_size, name: message.video.file_name || "video.mp4" };
  }
  if (message.audio) {
    return { fileId: message.audio.file_id, size: message.audio.file_size, name: message.audio.file_name || "audio.mp3" };
  }
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    return { fileId: largest.file_id, size: largest.file_size, name: `photo.jpg` };
  }
  return null;
}

async function serveFile(env, token, record) {
  // Forward (not copy) the message into the hidden relay channel — this is
  // the only Bot API call that returns the full Message object (with the
  // file's file_id) synchronously in its response.
  const forwarded = await telegramApi(record.botToken, "forwardMessage", {
    chat_id: record.relayChatId,
    from_chat_id: record.sourceChatId,
    message_id: record.messageId,
  });

  const file = extractFile(forwarded);
  if (!file) {
    return errorPage("Unsupported file", "This shared item isn't a downloadable file.", 400);
  }
  if (file.size && file.size > BOT_API_FILE_SIZE_LIMIT) {
    return errorPage(
      "File too large for an always-on link",
      "Telegram's Bot API only allows files up to 20MB through this relay. This file is larger — download it from a device where the desktop app is running instead.",
      413,
    );
  }

  const fileInfo = await telegramApi(record.botToken, "getFile", { file_id: file.fileId });

  // Best-effort cleanup — leaving the forwarded copy behind is harmless
  // clutter in a hidden channel nobody else can see, so a failure here
  // isn't worth failing the download over.
  telegramApi(record.botToken, "deleteMessage", {
    chat_id: record.relayChatId,
    message_id: forwarded.message_id,
  }).catch(() => {});

  record.usageCount = (record.usageCount || 0) + 1;
  await saveShare(env, token, record);

  // Fetch and stream the bytes through this Worker rather than redirecting
  // to Telegram's file URL — that URL embeds the raw bot token
  // (`.../bot<TOKEN>/<path>`), and a 302 hands it straight to the visitor's
  // browser (visible in the Location header, browser history, and any
  // download manager). Since that bot is also an admin on the source
  // channel, a leaked token is far more than "can download this one file".
  // Proxying keeps the token entirely server-side.
  const downloadUrl = `https://api.telegram.org/file/bot${record.botToken}/${fileInfo.file_path}`;
  const upstream = await fetch(downloadUrl);
  if (!upstream.ok || !upstream.body) {
    return errorPage("Download failed", "Could not fetch the file from Telegram.", 502);
  }

  const headers = new Headers();
  headers.set("content-type", upstream.headers.get("content-type") || "application/octet-stream");
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) headers.set("content-length", contentLength);
  headers.set("content-disposition", contentDisposition(file.name || "download"));
  headers.set("cache-control", "private, no-store");

  return new Response(upstream.body, { status: 200, headers });
}

// Builds a safe Content-Disposition header value for an arbitrary
// (Telegram-supplied) filename — strips characters that could break out of
// the quoted string or inject header fields, and adds an RFC 5987
// UTF-8-encoded fallback for non-ASCII names.
function contentDisposition(name) {
  const safeAscii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\\r\n]/g, "_");
  const encoded = encodeURIComponent(name);
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`;
}

function passwordForm(token, error) {
  return html(`
    <h1>Password required</h1>
    <p>This link is protected. Enter the password to continue.</p>
    <form method="POST" action="/s/${token}">
      <input type="password" name="password" placeholder="Password" autofocus required>
      <button type="submit">Continue</button>
    </form>
    ${error ? `<p class="error">${error}</p>` : ""}
  `);
}

async function handleShareRequest(request, env, token) {
  const record = await loadShare(env, token);
  if (!record || record.revoked) {
    return errorPage("Link not found", "This link doesn't exist or has been revoked.", 404);
  }
  if (record.expiresAt && Math.floor(Date.now() / 1000) > record.expiresAt) {
    return errorPage("Link expired", "This link is no longer valid.", 410);
  }
  if (record.usageLimit && record.usageCount >= record.usageLimit) {
    return errorPage("Usage limit reached", "This link has already been used the maximum number of times its creator allowed.", 429);
  }
  if (!(record.permissions & PERMISSIONS.DOWNLOAD)) {
    return errorPage("Not downloadable", "This link doesn't allow downloading files.", 403);
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const password = form.get("password") || "";
    const matches = record.passwordHash ? await bcrypt.compare(password, record.passwordHash) : true;
    if (!matches) {
      return passwordForm(token, "Incorrect password.");
    }
    const authToken = await makeAuthToken(env, token);
    return Response.redirect(`${new URL(request.url).origin}/s/${token}?auth=${encodeURIComponent(authToken)}`, 303);
  }

  if (record.passwordHash) {
    const authParam = new URL(request.url).searchParams.get("auth");
    const authed = await verifyAuthToken(env, token, authParam);
    if (!authed) {
      return passwordForm(token, null);
    }
  }

  try {
    return await serveFile(env, token, record);
  } catch (error) {
    return errorPage("Something went wrong", String(error.message || error), 502);
  }
}

// Internal API the desktop app calls (with a shared secret) to register,
// update, or revoke a share record — see tunnel/relay setup on the Rust side.
async function handleAdminRequest(request, env) {
  const authHeader = request.headers.get("authorization") || "";
  if (!timingSafeEqual(authHeader, `Bearer ${env.ADMIN_SECRET}`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const url = new URL(request.url);
  const token = url.pathname.split("/").pop();

  if (request.method === "PUT") {
    const record = await request.json();
    await saveShare(env, token, record);
    return new Response("OK");
  }
  if (request.method === "DELETE") {
    await env.SHARES.delete(`share:${token}`);
    return new Response("OK");
  }
  return new Response("Method not allowed", { status: 405 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/admin/shares/")) {
      return handleAdminRequest(request, env);
    }

    const match = url.pathname.match(/^\/s\/([A-Za-z0-9_-]+)$/);
    if (match) {
      return handleShareRequest(request, env, match[1]);
    }

    return errorPage("Not found", "Nothing here.", 404);
  },
};
