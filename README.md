# Zil

> An advanced, fully local YouTube notification extension. No account, no server, no tracking — everything stays in your browser.

The name comes from the Turkish word "zil", which means bell.

## Features

- **Video feed** — unified homepage with the latest videos from all tracked channels (thumbnails, relative times, Shorts/LIVE badges, unread highlighting).
- **Notifications + badge** — OS notification on new videos, unread counter on the toolbar icon.
- **Live detection** — catches live streams with per-channel on/off and adjustable probe intervals.
- **Title rules** — regex filters per video: block, notify, or mark important (global + per-channel, with first-match ordering and a self-test tool).
- **Quiet hours** — notifications drop to badge-only overnight; important videos can bypass.
- **Backup** — manual JSON export/import plus silent daily auto-backups with one-click restore.
- **i18n** — English + Türkçe, light/dark theme.

## Install (developer mode)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Click the Zil icon, add a channel (ID, channel URL, or `@handle`).

## Permissions — why each one

| Permission | Used for |
|---|---|
| `storage` | Channels, settings, themes, backups (local only) |
| `alarms` | Periodic feed checks (default every 15 min) |
| `notifications` | New-video / live alerts |
| `youtube.com` hosts | Reading public RSS feeds + live status (no login, no cookies) |

## Develop

```sh
node --check popup.js && node --check background.js && node --check modules/parser.js
node --test "tests/*.mjs"
```

`modules/parser.js` is intentionally chrome-free so it runs under plain node. See `.ai/AGENTS.md` (private notes, git-ignored) for contributor guidance.

## Notes

- Feeds poll on an interval; expect a few minutes of delay, not instant push.
- Live detection is best-effort (poll-based, throttled to save traffic).
- First public release: v1.0.0.
