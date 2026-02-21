# InstaClean – Instagram Activity Cleaner

A Chrome extension to bulk-remove your likes and comments from Instagram. Pure DOM-based — no API, no cookies, no credentials needed.

## Features

- **Remove Likes** — Bulk unlike posts from your activity page
- **Remove Comments** — Bulk delete your comments
- **Exclude Friends** — Skip comments on posts by people you follow/who follow you (comments only)
- **Batch Processing** — Processes items in safe batches of 15 to avoid Instagram limits
- **Multi-language** — Works with Instagram in 11 languages (EN, TR, ES, FR, DE, IT, PT, RU, JA, ZH, KO)
- **Floating Panel** — Persistent UI that stays open while you interact with Instagram

## Installation

1. Download or clone this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the project folder
5. The InstaClean icon appears in your toolbar

## Usage

1. Go to [instagram.com](https://www.instagram.com)
2. Click the **InstaClean icon** in your Chrome toolbar to open the panel
3. _(Optional)_ Enable **Exclude Friends** and sync your following/followers list
4. Click **Remove Likes** or **Remove Comments**
5. The extension will automatically process items in batches
6. Click **Stop** anytime to pause

> **Not working?** Try switching your Instagram language to **English** in Settings → Language. The extension supports 11 languages, but English is the most reliable.

## How It Works

The extension navigates to your Instagram activity pages and interacts with the real Instagram UI — clicking buttons, selecting checkboxes, and confirming dialogs — just like you would manually, but automated.

## Permissions

| Permission      | Why                                          |
| --------------- | -------------------------------------------- |
| `activeTab`     | Inject the floating panel on the current tab |
| `storage`       | Save settings and friend list locally        |
| `scripting`     | Run the content script on Instagram          |
| `instagram.com` | The extension only works on Instagram        |

## Privacy

- **No data leaves your browser** — everything runs locally
- **No API calls** — purely DOM-based
- **No credentials stored** — the extension never accesses your login info
- Friend lists are stored in `chrome.storage.local` on your machine only

## License

[CC BY-NC 4.0](LICENSE) — Free to use, share, and modify. **Not for commercial use.**
