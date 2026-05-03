/**
 * Send a file directly to a Telegram chat using the Bot API sendDocument endpoint.
 * Mirrors mai-image plugin's sendTelegramPhoto but for arbitrary file types.
 *
 * Telegram cap: 50 MB for bot uploads via multipart form.
 *
 * @param {{
 *   botToken: string,
 *   chatId: string,
 *   buffer: Buffer,
 *   filename: string,
 *   contentType?: string,
 *   caption?: string,
 * }} opts
 * @returns {Promise<boolean>} true if sendDocument succeeded
 */
async function sendTelegramDocument({
  botToken,
  chatId,
  buffer,
  filename,
  contentType,
  caption,
}) {
  const blob = new Blob([buffer], { type: contentType || "application/octet-stream" });

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("document", blob, filename);
  if (caption) {
    // Telegram caps captions at 1024 chars
    const truncated = caption.length > 1024 ? caption.slice(0, 1021) + "..." : caption;
    form.append("caption", truncated);
  }

  const url = `https://api.telegram.org/bot${botToken}/sendDocument`;
  const resp = await fetch(url, { method: "POST", body: form });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Telegram sendDocument failed: ${resp.status} ${text}`);
  }
  return true;
}

module.exports = { sendTelegramDocument };
