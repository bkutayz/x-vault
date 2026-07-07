# X-Vault: Top 5 New Features (First-Principles Analysis)

## How this was derived
I mapped the current product to the core value chain:

1. capture signal
2. retrieve relevant context
3. generate insight
4. take action quickly
5. compound knowledge over time

The highest-impact new features are the ones that remove the biggest bottlenecks in that chain.

## Ranked Feature List

### 1) Watchlists + Real-Time Alerts (from passive archive -> active intelligence)
- Core user problem: users miss important tweets unless they manually browse at the right time.
- Why impact is highest: timeliness matters more than archive depth for decision-making and engagement.
- Evidence this is missing now:
  - capture is page-driven in `content.js` (`shouldCaptureOnPage`, `processTweets`) and depends on browsing behavior.
  - no watchlist/alert/notification pipeline exists in `background.js`/`dashboard.js`.
- Clear MVP:
  - add `watchlists` store (handles, keywords, metric thresholds).
  - evaluate each `STORE_TWEET` event against rules.
  - show `chrome.notifications` + in-app alert inbox.
- Success metric: % of high-value tweets seen within 10 minutes of capture.

### 2) Semantic Search + Similar Tweet Retrieval (from keyword lookup -> idea lookup)
- Core user problem: lexical search misses semantically relevant tweets (synonyms, paraphrases, multilingual phrasing).
- Why impact is high: retrieval quality determines everything downstream (analysis, writing, replies).
- Evidence this is missing now:
  - search is token/inverted-index + substring matching in `db.js` (`tokenizeText`, `searchTweets`, `includes(lowerText)`).
  - no embedding/vector index exists in schema.
- Clear MVP:
  - add embedding field/index for tweets.
  - implement hybrid ranking (keyword + vector similarity).
  - add "Similar tweets" on each tweet card.
- Success metric: recall@k improvement on known queries and lower failed-search rate.

### 3) Opportunity Inbox with Signal Scoring (from feed browsing -> prioritized action queue)
- Core user problem: too many tweets, unclear which ones deserve response or deeper analysis.
- Why impact is high: attention is the scarcest resource; prioritization directly increases user output.
- Evidence this is missing now:
  - ranking options are only `date`, `likes`, `views` in `dashboard.js`.
  - no composite relevance score (author priority, recency, engagement velocity, keyword match).
- Clear MVP:
  - scoring engine in background on new captures.
  - configurable weights in Settings.
  - dedicated "Opportunities" view with quick actions (reply/collection/export).
- Success metric: higher reply rate per session and shorter time-to-first-action.

### 4) Thread & Conversation Reconstruction (from isolated tweets -> full context)
- Core user problem: single tweets are often ambiguous without thread/conversation context.
- Why impact is high: context quality improves interpretation accuracy and response quality.
- Evidence this is missing now:
  - `content.js` captures `inReplyToId` and `isThread`.
  - UI only shows badges (`thread-badge`, `reply-badge`) in `dashboard.js`; no thread view or reconstruction.
- Clear MVP:
  - build parent/child thread graph from `inReplyToId`.
  - add thread view with chronological chain + missing-node placeholders.
  - thread-level export to LLM prompts.
- Success metric: reduced "misread context" errors and higher quality LLM outputs.

### 5) Auto Briefs (daily/weekly) with Evidence Links (from manual copy-paste -> compounding memory)
- Core user problem: users repeatedly re-analyze the same corpus manually.
- Why impact is high: converts raw capture into reusable knowledge artifacts automatically.
- Evidence this is missing now:
  - analysis workflow is largely manual copy-to-clipboard (`LLM_PROMPTS`, export buttons) in `dashboard.js`.
  - no scheduled summarization pipeline despite alarms existing for backups in `background.js`.
- Clear MVP:
  - scheduler using `chrome.alarms` for digest jobs.
  - generate topic/user briefs with cited tweet links.
  - save outputs into `blogPosts` store + exportable Markdown.
- Success metric: number of briefs consumed per week and repeat usage of saved briefs.

## Why these 5 (and not others)
These features attack the highest-leverage gaps in order:

1. timeliness gap (watchlists/alerts)
2. retrieval gap (semantic search)
3. prioritization gap (opportunity scoring)
4. context gap (thread reconstruction)
5. compounding gap (auto briefs)

They are also additive to the current architecture (content -> background -> IndexedDB -> dashboard), so they can be shipped incrementally.
