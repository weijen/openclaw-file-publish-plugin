// Copied verbatim from openclaw-mai-image-plugin v0.1.0 (see ../README.md "Acknowledgements").
// Keep in sync if upstream signing logic changes.

const https = require("https");
const crypto = require("crypto");

/**
 * Build the Authorization header for Azure Blob Storage Shared Key auth.
 * Ref: https://learn.microsoft.com/en-us/rest/api/storageservices/authorize-with-shared-key
 */
function buildSharedKeyAuthHeader({
  accountName,
  accountKey,
  method,
  contentLength,
  contentType,
  blobType,
  date,
  urlPath,
}) {
  const canonicalHeaders = [
    `x-ms-blob-type:${blobType}`,
    `x-ms-date:${date}`,
    `x-ms-version:2024-11-04`,
  ].join("\n");

  const canonicalResource = `/${accountName}${urlPath}`;

  // StringToSign for Blob service Shared Key:
  // VERB\nContent-Encoding\nContent-Language\nContent-Length\nContent-MD5\nContent-Type\n
  // Date\nIf-Modified-Since\nIf-Match\nIf-None-Match\nIf-Unmodified-Since\nRange\n
  // CanonicalHeaders\nCanonicalResource
  const stringToSign = [
    method,           // VERB
    "",               // Content-Encoding
    "",               // Content-Language
    contentLength,    // Content-Length
    "",               // Content-MD5
    contentType,      // Content-Type
    "",               // Date (empty because we use x-ms-date)
    "",               // If-Modified-Since
    "",               // If-Match
    "",               // If-None-Match
    "",               // If-Unmodified-Since
    "",               // Range
    canonicalHeaders,
    canonicalResource,
  ].join("\n");

  const hmac = crypto.createHmac("sha256", Buffer.from(accountKey, "base64"));
  hmac.update(stringToSign, "utf-8");
  const signature = hmac.digest("base64");

  return `SharedKey ${accountName}:${signature}`;
}

/**
 * Build the public URL for a blob.
 */
function buildBlobUrl(accountName, containerName, blobName) {
  return `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}`;
}

/**
 * Upload a buffer to Azure Blob Storage and return the public URL.
 */
function uploadToBlob({ accountName, accountKey, containerName, blobName, buffer, contentType }) {
  return new Promise((resolve, reject) => {
    const urlPath = `/${containerName}/${blobName}`;
    const date = new Date().toUTCString();
    const authorization = buildSharedKeyAuthHeader({
      accountName,
      accountKey,
      method: "PUT",
      contentLength: buffer.length,
      contentType,
      blobType: "BlockBlob",
      date,
      urlPath,
    });

    const url = `https://${accountName}.blob.core.windows.net${urlPath}`;
    const req = https.request(
      url,
      {
        method: "PUT",
        headers: {
          "Content-Type": contentType,
          "Content-Length": buffer.length,
          "x-ms-blob-type": "BlockBlob",
          "x-ms-date": date,
          "x-ms-version": "2024-11-04",
          Authorization: authorization,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode === 201) {
            resolve(buildBlobUrl(accountName, containerName, blobName));
          } else {
            const body = Buffer.concat(chunks).toString();
            reject(new Error(`Blob upload failed (HTTP ${res.statusCode}): ${body.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(buffer);
    req.end();
  });
}

module.exports = { buildSharedKeyAuthHeader, buildBlobUrl, uploadToBlob };
