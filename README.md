# X-Vault

Chrome extension that passively captures tweets as you browse Twitter/X. Store them locally, search across them, and export to LLMs.

## What it does

- Captures tweets from any profile you visit — no API keys needed
- Stores everything locally in your browser (IndexedDB)
- Search across all captured tweets
- One-click export with LLM prompt templates ("Summarize thinking", "Key beliefs", etc.)
- Star users you care about, block/delete the rest
- Bulk cleanup: remove anyone with N or fewer tweets

## Install

1. Clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the repo folder

## Usage

1. Browse any Twitter/X profile — tweets are captured automatically
2. Click the extension icon to see a quick summary, or click **Dashboard** for the full UI
3. Use the sidebar to browse users, search bar to find tweets
4. Click any **Ask LLM** button to copy tweets + a prompt to your clipboard, then paste into Claude/ChatGPT

## Screenshots

Captured tweets show a blue **CAPTURED** badge on the Twitter page. Blocked users show a red **BLOCKED** badge.

The dashboard gives you a full-page view with user management, notes, search, and LLM export.

## Files

```
manifest.json   - Chrome extension manifest (MV3)
content.js      - Scrapes tweets from Twitter/X pages
background.js   - Service worker handling storage
db.js           - IndexedDB operations
dashboard.*     - Full-page dashboard UI
popup.*         - Extension popup UI
icons/          - Extension icons
```

## License

MIT
