---
title: OpenClaw File Publish Plugin
description: Publish locally generated files (.docx/.xlsx/.pptx/.pdf/...) to Azure Blob Storage and deliver them to chat channels.
---

# OpenClaw File Publish Plugin

A small, zero-dependency plugin that registers a single `publish_file`
tool. The agent calls it after producing a file in its workspace
(typically with `pandoc`, `libreoffice --headless`, or `wkhtmltopdf`),
and the plugin uploads the file to Azure Blob Storage and delivers it
to the active chat channel.

| Channel | Delivery |
|---|---|
| Telegram | Inline file via Bot API `sendDocument` **+** public URL in the tool result |
| LINE | Public HTTPS URL in the tool result text |
| WhatsApp | Public HTTPS URL in the tool result text |
| Anything else | Public HTTPS URL only |

## Why a separate plugin

The `mai-image` plugin already ships a similar pattern for images.
This plugin generalises that pattern to **any** generated artifact —
Word, Excel, PowerPoint, PDF, CSV, ZIP, etc. — without coupling
document delivery to image generation.

## Repository layout

- `index.js` — plugin entry point (`registerTool` factory pattern)
- `lib/blob.js` — Azure Blob Storage upload helper (Shared Key auth)
- `lib/delivery.js` — Telegram Bot API `sendDocument` helper
- `lib/file.js` — path safety, MIME mapping, blob name builder
- `test/` — regression tests (`node --test`)
- `openclaw.plugin.json` — plugin manifest and configuration schema

## Configuration

See [`example-config.json`](./example-config.json) for a minimal
example.

| Key | Required | Description |
|---|---|---|
| `mediaStorageAccount` | yes | Azure Blob Storage account name |
| `mediaStorageKey` | yes | Storage shared key (or `__KEYVAULT__:` placeholder if your host resolves it) |
| `documentsContainer` | no (default `documents`) | Blob container name |
| `workspaceRoot` | yes | Absolute path the agent is allowed to publish from. Files outside this root are **rejected**. |
| `maxSizeMB` | no (default 50) | Hard upload limit |
| `telegramMaxSizeMB` | no (default 50) | Limit for Telegram inline `sendDocument` (Telegram bot cap is 50 MB) |

## Tool contract

```jsonc
{
  "name": "publish_file",
  "input": {
    "path": "<absolute path inside workspaceRoot>",
    "displayName": "<optional shown filename>",
    "caption": "<optional one-line caption>"
  }
}
```

### Result

```jsonc
{
  // On Telegram (delivered via sendDocument): "✅ report.pdf"
  // On LINE / WhatsApp (URL-only delivery):    "📎 report.pdf\nhttps://..."
  "content": [{ "type": "text", "text": "..." }],
  "details": {
    "status": "ok",
    "deliveryMode": "telegram-direct" | "url",
    "publicUrl": "https://...",
    "size": 12345,
    "contentType": "application/pdf"
  }
}
```

The tool result text intentionally **omits** the public URL on Telegram so the
agent does not echo a redundant link next to a file the user already received
inline. The `details.publicUrl` field always carries the URL for audit / log
purposes regardless of channel.

### Errors

- `path` — file missing, outside `workspaceRoot`, a directory, or a
  symlink that escapes the root
- `too_large` — exceeds `maxSizeMB`
- `no_storage` — `mediaStorageAccount` or storage key not configured
- `blob_upload` — Azure Blob REST API rejected the upload

Each error is logged via the audit hook (see below) and returned to
the agent as a clear, recoverable text message.

## Security boundary

`workspaceRoot` is the **only** thing standing between the agent and
arbitrary file exfiltration. The plugin uses `fs.realpath` on both the
root and the requested file to detect symlink escapes, then asserts
the relative path does not start with `..`.

Storage keys are resolved at request time:

1. `pluginConfig.mediaStorageKey` (if not a `__KEYVAULT__:` placeholder)
2. `api.resolveSecret("media-storage-key")` (host-injected)
3. `process.env.MEDIA_STORAGE_KEY`

The plugin **never** logs the storage key, file contents, captions, or
prompts.

## Audit logging

Every `publish_file` call emits one structured JSON line via
`api.logger.info` (or stdout fallback):

```json
{"event":"file_publish","channel":"telegram","to":"telegram:1234","filename":"report.pdf","size":42013,"contentType":"application/pdf","publicUrl":"https://...","deliveryMode":"telegram-direct","status":"ok"}
```

In hosts that pipe stdout to journald + Azure Monitor Agent, these
lines surface in Log Analytics under the `Syslog` table and can be
charted with KQL.

## Testing

```bash
npm test
```

## Acknowledgements

`lib/blob.js` is copied verbatim from
[`weijen/openclaw-mai-image-plugin`](https://github.com/weijen/openclaw-mai-image-plugin).
Both plugins stay zero-dependency on purpose; if a third consumer
appears we will extract a small shared `openclaw-azure-blob` package.

## License

MIT
