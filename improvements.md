# Potential Improvement Areas

This document lists potential improvement areas for X-Vault based on repo evidence and code review of the extension implementation.

## Product + UX
- Provide first-run onboarding and clearer status indicators (e.g., capture on/off, home feed capture state) to reduce confusion about when captures happen.
- Add a visible “capture paused” toggle in the dashboard and/or floating button (currently home feed capture is only in Settings).
- Surface blocked-user state more clearly in the UI (e.g., banner or filter in Users view), not only via badges on tweets.
- Add keyboard shortcuts for common actions (open dashboard, copy/export, search focus).
- Improve empty states with action hints (e.g., “Browse a profile to start capturing”).

## Data Model + Search
- Normalize and version stored tweet fields more explicitly (e.g., optional fields for quote tweets, media URLs, thread info).
- Expand search to include full-text index updates when tweets are deleted or edited; verify index consistency across all delete paths.
- Add a lightweight “data health” screen (counts, index size, last capture timestamp) to help troubleshoot.

## Performance + Scalability
- Consider pagination or virtualized lists in Users and Tweets views to handle large datasets.
- Add throttling or backoff for DOM scanning on heavy timelines to minimize CPU usage.
- Optimize search and sorting for very large datasets (e.g., IndexedDB indexes for sort keys like `likeCount` or `viewCount`).

## Reliability + Edge Cases
- Improve resilience to Twitter/X DOM changes by narrowing selectors and adding fallbacks for key fields (tweet text, handles, metrics).
- Add explicit handling for rate-limited or partially rendered timelines (e.g., “data incomplete” warning).
- Clarify behavior for tweets without visible text (media-only, polls, link cards) and for retweets/reposts.

## Privacy + Security
- Add a short privacy note in the UI or README clarifying local-only storage and what data is captured.
- Provide a quick “delete all data” option in Settings for data hygiene.
- Consider permissions minimization: verify if `activeTab` is needed in addition to host permissions.

## Maintainability
- Introduce shared constants for message types and DOM selectors to reduce drift between content script and background/dashboard.
- Split `content.js` into smaller modules (extract selectors, extract data parsing, capture control) to reduce complexity.
- Add lightweight logging toggles (e.g., verbose mode) rather than always logging in background.

## Testing
- Add unit tests for parsing/formatting helpers (e.g., metric parsing, date formatting).
- Add integration tests for IndexedDB functions (store/retrieve, search index integrity, import/export).
- Add a small set of DOM fixture tests for tweet extraction to catch Twitter/X DOM changes.

## Documentation
- Expand README with:
  - A brief architecture overview (content script -> background -> IndexedDB -> dashboard)
  - Supported capture contexts and limitations
  - Backup/restore workflow
  - Troubleshooting (e.g., if captures stop, reload extension)

## Observability + Debugging
- Add a diagnostic panel (recent errors, capture counts, last DOM scan time) to speed up user troubleshooting.
- Include a “copy debug info” button for sharing anonymized logs.
