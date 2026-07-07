(() => {
  const { q, qAll } = window.XVaultSelectors;
  const processedIds = new Set();
  let debounceTimer = null;
  let currentProfileHandle = null;
  let floatingBtn = null;
  let contextInvalidated = false;
  const RESERVED_ROUTES = new Set([
    'home',
    'following',
    'explore',
    'notifications',
    'messages',
    'search',
    'settings',
    'bookmarks',
    'communities',
    'lists',
    'jobs',
    'topics',
    'i',
    'compose',
    'intent',
    'share'
  ]);

  // Helper to safely send messages when extension context may be invalidated
  function safeSendMessage(message) {
    if (contextInvalidated || !chrome.runtime?.id) {
      contextInvalidated = true;
      return Promise.reject(new Error('Extension context invalidated'));
    }
    return chrome.runtime.sendMessage(message);
  }

  // Inject styles for the captured badge and floating button
  const style = document.createElement('style');
  style.textContent = `
    .ts-captured-badge {
      position: absolute;
      top: 4px;
      right: 4px;
      width: 20px;
      height: 20px;
      z-index: 10;
      pointer-events: none;
      opacity: 0.5;
    }
    .ts-captured-badge svg {
      width: 100%;
      height: 100%;
      fill: #17bf63;
    }
    .ts-blocked-badge {
      position: absolute;
      top: 4px;
      right: 4px;
      background: #e0245e;
      color: #fff;
      font-size: 10px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      padding: 2px 6px;
      border-radius: 4px;
      z-index: 10;
      pointer-events: none;
      opacity: 0.85;
    }
    .ts-floating-btn {
      position: relative;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: #1DA1F2;
      border: 3px solid #fff;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .ts-floating-btn:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 16px rgba(0,0,0,0.4);
    }
    .ts-floating-btn img {
      width: 50px;
      height: 50px;
      object-fit: cover;
      border-radius: 50%;
      pointer-events: none;
    }
    .ts-floating-btn svg {
      pointer-events: none;
    }
    .ts-floating-btn .ts-count-badge {
      position: absolute;
      bottom: -2px;
      right: -2px;
      background: #e0245e;
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      padding: 2px 6px;
      border-radius: 10px;
      min-width: 20px;
      text-align: center;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      border: 2px solid #fff;
      pointer-events: none;
    }
    .ts-floating-btn .ts-default-icon {
      width: 28px;
      height: 28px;
      fill: #fff;
    }
    .ts-floating-container {
      position: fixed;
      top: 80px;
      right: 20px;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      z-index: 9999;
    }
    .ts-block-btn {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #e0245e;
      border: 2px solid #fff;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s, box-shadow 0.2s, background 0.2s;
    }
    .ts-block-btn:hover {
      transform: scale(1.1);
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      background: #c5203e;
    }
    .ts-block-btn.blocked {
      background: #17bf63;
    }
    .ts-block-btn.blocked:hover {
      background: #14a857;
    }
    .ts-block-btn svg {
      width: 16px;
      height: 16px;
      fill: #fff;
      pointer-events: none;
    }
    .ts-bookmark-grab-btn {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 10000;
      background: #1DA1F2;
      color: #fff;
      border: none;
      border-radius: 24px;
      padding: 12px 20px;
      font-size: 14px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s, background 0.2s;
    }
    .ts-bookmark-grab-btn:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 6px 16px rgba(0,0,0,0.4);
    }
    .ts-bookmark-grab-btn:disabled {
      background: #8ecdf5;
      cursor: default;
    }
  `;
  document.head.appendChild(style);

  // Create floating button
  let floatingContainer = null;
  let blockBtn = null;
  let isCurrentUserBlocked = false;

  function createFloatingButton() {
    if (floatingContainer) return;

    // Create container
    floatingContainer = document.createElement('div');
    floatingContainer.className = 'ts-floating-container';

    // Create main button
    floatingBtn = document.createElement('div');
    floatingBtn.className = 'ts-floating-btn';
    floatingBtn.title = 'X-Vault - Click to open';
    floatingBtn.innerHTML = `
      <svg class="ts-default-icon" viewBox="0 0 24 24">
        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14l-5-5 1.41-1.41L12 14.17l4.59-4.59L18 11l-6 6z"/>
      </svg>
      <div class="ts-count-badge">0</div>
    `;

    floatingBtn.addEventListener('click', () => {
      // Send message to open popup - this will trigger background to open popup
      safeSendMessage({ type: 'OPEN_POPUP' }).catch(() => { });
    });

    // Create block button
    blockBtn = document.createElement('div');
    blockBtn.className = 'ts-block-btn';
    blockBtn.title = 'Block this user from capture';
    blockBtn.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
      </svg>
    `;

    blockBtn.addEventListener('click', async () => {
      if (!currentProfileHandle) return;

      try {
        if (isCurrentUserBlocked) {
          // Unblock user
          await safeSendMessage({ type: 'UNBLOCK_USER', handle: currentProfileHandle });
          isCurrentUserBlocked = false;
          blockBtn.classList.remove('blocked');
          blockBtn.title = 'Block this user from capture';
          blockBtn.innerHTML = `
            <svg viewBox="0 0 24 24">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          `;
        } else {
          // Block user
          await safeSendMessage({ type: 'BLOCK_USER', handle: currentProfileHandle });
          isCurrentUserBlocked = true;
          blockBtn.classList.add('blocked');
          blockBtn.title = 'Unblock this user';
          blockBtn.innerHTML = `
            <svg viewBox="0 0 24 24">
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
            </svg>
          `;
          // Update count badge to 0 since user is now blocked
          const countBadge = floatingBtn.querySelector('.ts-count-badge');
          if (countBadge) countBadge.textContent = '0';
        }
      } catch (e) {
        console.error('[X-Vault] Error toggling block:', e);
      }
    });

    floatingContainer.appendChild(floatingBtn);
    floatingContainer.appendChild(blockBtn);
    document.body.appendChild(floatingContainer);
  }

  // Update floating button with user info
  async function updateFloatingButton(handle, avatarUrl) {
    if (!floatingBtn) createFloatingButton();

    currentProfileHandle = handle;

    // Update avatar
    if (avatarUrl) {
      const existingImg = floatingBtn.querySelector('img');
      const existingSvg = floatingBtn.querySelector('svg');

      if (existingImg) {
        existingImg.src = avatarUrl;
      } else {
        if (existingSvg) existingSvg.remove();
        const img = document.createElement('img');
        img.src = avatarUrl;
        img.alt = `@${handle}`;
        floatingBtn.insertBefore(img, floatingBtn.firstChild);
      }
    }

    // Get user tweet count and check blocked status
    try {
      const [user, blockedUsers] = await Promise.all([
        safeSendMessage({ type: 'GET_USER', handle }),
        safeSendMessage({ type: 'GET_BLOCKED_USERS' })
      ]);

      const countBadge = floatingBtn.querySelector('.ts-count-badge');
      if (countBadge) {
        countBadge.textContent = user?.tweetCount || 0;
      }

      // Update block button state
      isCurrentUserBlocked = blockedUsers?.includes(handle) || false;
      if (blockBtn) {
        if (isCurrentUserBlocked) {
          blockBtn.classList.add('blocked');
          blockBtn.title = 'Unblock this user';
          blockBtn.innerHTML = `
            <svg viewBox="0 0 24 24">
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
            </svg>
          `;
        } else {
          blockBtn.classList.remove('blocked');
          blockBtn.title = 'Block this user from capture';
          blockBtn.innerHTML = `
            <svg viewBox="0 0 24 24">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          `;
        }
      }
    } catch (e) {
      // Ignore errors
    }

    floatingBtn.title = `@${handle} - Click to open X-Vault`;
  }

  // Detect current profile from URL
  function detectProfileFromURL() {
    const path = window.location.pathname;
    const match = path.match(/^\/([a-zA-Z0-9_]+)/);

    if (match && !RESERVED_ROUTES.has(match[1].toLowerCase())) {
      return match[1].toLowerCase();
    }
    return null;
  }

  // Extract profile avatar from page
  function getProfileAvatar() {
    // Try to get avatar from profile header
    const profileImg = q(document, 'profilePhoto');
    if (profileImg) return profileImg.src;

    // Fallback: get from first tweet by this user
    const handle = detectProfileFromURL();
    if (handle) {
      const articles = qAll(document, 'tweet');
      for (const article of articles) {
        const link = article.querySelector(`a[href="/${handle}" i]`);
        if (link) {
          const img = q(article, 'avatar');
          if (img) return img.src;
        }
      }
    }
    return null;
  }

  // Check and update profile button
  function checkProfile() {
    const handle = detectProfileFromURL();
    if (handle && handle !== currentProfileHandle) {
      const avatar = getProfileAvatar();
      updateFloatingButton(handle, avatar);
    } else if (handle && currentProfileHandle === handle) {
      // Same profile, just refresh the count
      refreshButtonCount();
    }
  }

  // Refresh just the count
  async function refreshButtonCount() {
    if (!currentProfileHandle || !floatingBtn) return;

    try {
      const user = await safeSendMessage({ type: 'GET_USER', handle: currentProfileHandle });
      const countBadge = floatingBtn.querySelector('.ts-count-badge');
      if (countBadge) {
        countBadge.textContent = user?.tweetCount || 0;
      }
    } catch (e) {
      // Ignore errors
    }
  }

  function getHomeTimelineMode() {
    const path = (window.location.pathname || '').toLowerCase();
    const params = new URLSearchParams(window.location.search || '');
    const feedParam = (params.get('f') || '').toLowerCase();

    // X often uses /home?f=live for Following
    if (path === '/following' || feedParam === 'live') return 'following';
    if (path === '/home' || path === '/' || path === '') {
      const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
      const activeText = (activeTab?.textContent || '').toLowerCase();
      if (activeText.includes('following')) return 'following';
      if (activeText.includes('for you') || activeText.includes('foryou')) return 'for_you';
      return 'home';
    }
    return null;
  }

  function parseStatusHref(href) {
    if (!href) return null;

    try {
      const parsed = new URL(href, window.location.origin);
      const parts = parsed.pathname.split('/').filter(Boolean);
      const statusIdx = parts.findIndex((p) => p.toLowerCase() === 'status');
      if (statusIdx < 1 || !parts[statusIdx + 1]) return null;

      const handle = parts[statusIdx - 1].replace(/^@/, '').toLowerCase();
      const tweetId = parts[statusIdx + 1];
      if (!tweetId || !/^\d+$/.test(tweetId) || !handle) return null;
      return { handle, tweetId };
    } catch {
      return null;
    }
  }

  function markCaptured(article) {
    if (article.querySelector('.ts-captured-badge') || article.querySelector('.ts-blocked-badge')) return;
    article.style.position = 'relative';
    const badge = document.createElement('div');
    badge.className = 'ts-captured-badge';
    badge.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
      </svg>
    `;
    article.appendChild(badge);
  }

  function markBlocked(article) {
    if (article.querySelector('.ts-blocked-badge') || article.querySelector('.ts-captured-badge')) return;
    article.style.position = 'relative';
    const badge = document.createElement('div');
    badge.className = 'ts-blocked-badge';
    badge.textContent = 'BLOCKED';
    article.appendChild(badge);
  }

  function extractTweetData(article) {
    // Prefer permalink around the tweet's own time element.
    const timeEl = q(article, 'time');
    const primaryStatusLink = timeEl?.closest('a[href*="/status/"]');
    const statusLink = primaryStatusLink || q(article, 'statusLink');
    if (!statusLink) return null;

    const parsedStatus = parseStatusHref(statusLink.getAttribute('href') || '');
    if (!parsedStatus) return null;
    const { handle, tweetId } = parsedStatus;

    // Timestamp
    const timestamp = timeEl ? timeEl.getAttribute('datetime') : new Date().toISOString();

    // Tweet text
    const textEl = q(article, 'tweetText');
    let fullText = textEl ? textEl.innerText : '';

    // Fallback: extract text from embedded article/card if tweet text is empty
    if (!fullText) {
      const cardEl = q(article, 'cardWrapper');
      if (cardEl) {
        const cardText = cardEl.innerText.trim();
        if (cardText) {
          fullText = cardText.replace(/^\s*Article\s*\n?/i, '').trim();
        }
      }
    }

    // Display name and handle from User-Name
    const userNameEl = q(article, 'userName');
    let displayName = '';
    if (userNameEl) {
      const nameLink = userNameEl.querySelector('a');
      if (nameLink) {
        const spans = nameLink.querySelectorAll('span');
        for (const span of spans) {
          const text = span.textContent.trim();
          if (text && !text.startsWith('@')) {
            displayName = text;
            break;
          }
        }
      }
    }

    // Avatar
    const avatarImg = q(article, 'avatar');
    const avatarUrl = avatarImg ? avatarImg.getAttribute('src') : '';

    // Detect retweet
    const socialContext = q(article, 'socialContext');
    let isRetweet = false;
    let retweetedBy = null;
    if (socialContext && socialContext.textContent.toLowerCase().includes('reposted')) {
      isRetweet = true;
      const retweeterLink = socialContext.querySelector('a[href^="/"]');
      if (retweeterLink) {
        retweetedBy = retweeterLink.getAttribute('href').replace('/', '').toLowerCase();
      }
    }

    // Extract engagement metrics
    let likeCount = 0;
    let impressionCount = 0;
    let replyCount = 0;
    let retweetCount = 0;
    let bookmarkCount = 0;
    let viewCount = 0;

    // Helper: extract count from a button by selector key
    function extractButtonCount(selectorKeys) {
      for (const key of selectorKeys) {
        const btn = q(article, key);
        if (!btn) continue;
        const label = btn.getAttribute('aria-label') || '';
        const match = label.match(/([\d,\.]+[KkMm]?)/);
        if (match) {
          const val = parseMetricValue(match[1]);
          if (val > 0) return val;
        }
        const spans = btn.querySelectorAll('span');
        for (const span of spans) {
          const text = span.textContent.trim();
          if (/^[\d,\.]+[KkMm]?$/.test(text)) {
            const val = parseMetricValue(text);
            if (val > 0) return val;
          }
        }
      }
      return 0;
    }

    // Reply count
    replyCount = extractButtonCount(['reply']);

    // Retweet count
    retweetCount = extractButtonCount(['retweet']);

    // Like count
    likeCount = extractButtonCount(['like']);

    // Bookmark count
    bookmarkCount = extractButtonCount(['bookmark']);

    // Views/impressions - look for the analytics link
    const viewLink = q(article, 'analyticsLink');
    if (viewLink) {
      viewCount = parseMetricValue(viewLink.textContent.trim());
    }

    // Fallback: look in aria-label of the views icon or parent container
    if (viewCount === 0) {
      const allLinks = article.querySelectorAll('a[role="link"]');
      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        if (href.includes('analytics')) {
          const val = parseMetricValue(link.textContent.trim());
          if (val > 0) { viewCount = val; break; }
        }
      }
    }

    // Final fallback: find the group with aria-label containing "views"
    if (viewCount === 0) {
      const actionGroups = qAll(article, 'actionGroup');
      for (const group of actionGroups) {
        const ariaLabel = group.getAttribute('aria-label') || '';
        const viewMatch = ariaLabel.match(/([\d,\.]+[KkMm]?)\s*view/i);
        if (viewMatch) {
          viewCount = parseMetricValue(viewMatch[1]);
          break;
        }
      }
    }

    impressionCount = viewCount;

    // --- Media extraction ---
    const mediaUrls = [];
    // Images
    const mediaImgs = article.querySelectorAll('img[src*="pbs.twimg.com/media"]');
    for (const img of mediaImgs) {
      const src = img.src;
      if (src && !mediaUrls.includes(src)) mediaUrls.push(src);
    }
    // Video poster/thumbnails
    const videoEls = article.querySelectorAll('video');
    for (const vid of videoEls) {
      const poster = vid.getAttribute('poster');
      if (poster && !mediaUrls.includes(poster)) mediaUrls.push(poster);
    }
    // Amplification cards with images
    const cardImgs = article.querySelectorAll('[data-testid="card.wrapper"] img[src*="pbs.twimg.com"]');
    for (const img of cardImgs) {
      const src = img.src;
      if (src && !mediaUrls.includes(src)) mediaUrls.push(src);
    }

    // Link card extraction
    let linkCard = null;
    const cardWrapper = q(article, 'cardWrapper');
    if (cardWrapper) {
      const cardLink = cardWrapper.querySelector('a[href]');
      const cardTitle = cardWrapper.querySelector('[data-testid="card.layoutLarge.detail"], [data-testid="card.layoutSmall.detail"]');
      if (cardLink) {
        linkCard = {
          url: cardLink.href,
          title: cardTitle?.querySelector('span')?.textContent || '',
          domain: cardLink.hostname || ''
        };
      }
    }

    // --- Thread / Reply detection ---
    let inReplyToId = null;
    let isThread = false;
    // Check for "Replying to" indicator
    const replyIndicators = article.querySelectorAll('div[dir="ltr"]');
    for (const el of replyIndicators) {
      if (el.textContent.includes('Replying to')) {
        // Try to extract the status link of the parent tweet
        const replyLinks = article.querySelectorAll('a[href*="/status/"]');
        for (const link of replyLinks) {
          const linkHref = link.getAttribute('href');
          if (linkHref && linkHref !== `/status/${tweetId}` && !linkHref.endsWith(`/status/${tweetId}`)) {
            const replyParts = linkHref.split('/');
            const replyStatusIdx = replyParts.indexOf('status');
            if (replyStatusIdx >= 0 && replyParts[replyStatusIdx + 1]) {
              inReplyToId = replyParts[replyStatusIdx + 1];
              break;
            }
          }
        }
        break;
      }
    }
    // Self-thread detection: same author replying to themselves
    if (inReplyToId && handle === detectProfileFromURL()) {
      isThread = true;
    }

    return {
      tweetId,
      handle,
      displayName,
      fullText,
      timestamp,
      url: `https://x.com/${handle}/status/${tweetId}`,
      avatarUrl,
      capturedAt: new Date().toISOString(),
      isRetweet,
      retweetedBy,
      replyCount,
      retweetCount,
      likeCount,
      bookmarkCount,
      viewCount,
      impressionCount,
      mediaUrls,
      linkCard,
      inReplyToId,
      isThread
    };
  }

  // Check if we should capture on current page
  function shouldCaptureOnPage() {
    const path = window.location.pathname;
    const homeMode = getHomeTimelineMode();

    // Always capture on specific tweet pages (/username/status/id)
    if (path.includes('/status/')) return { capture: true, isHome: false };

    // Home timelines (For you / Following / custom home tabs)
    if (homeMode) {
      return { capture: false, isHome: true, homeMode };
    }

    // Check if we're on a profile page (not a reserved route)
    const match = path.match(/^\/([a-zA-Z0-9_]+)/);
    if (match && !RESERVED_ROUTES.has(match[1].toLowerCase())) {
      return { capture: true, isHome: false, homeMode: null };
    }

    // Default: treat as non-capture route
    return { capture: false, isHome: false, homeMode: null };
  }

  // Parse values like "1.2K", "5M", "123" into numbers
  function parseMetricValue(str) {
    if (!str) return 0;
    str = str.replace(/,/g, '').trim();
    const match = str.match(/^([\d.]+)([KkMm])?$/);
    if (!match) return 0;
    let num = parseFloat(match[1]);
    if (match[2]) {
      const suffix = match[2].toUpperCase();
      if (suffix === 'K') num *= 1000;
      else if (suffix === 'M') num *= 1000000;
    }
    return Math.round(num);
  }

  // Home feed settings cache (refreshed periodically)
  let homeFeedSettingsCache = null;
  let homeFeedSettingsLastFetch = 0;
  const SETTINGS_CACHE_TTL = 5000; // 5 seconds

  async function getHomeFeedSettingsCached() {
    const now = Date.now();
    if (!homeFeedSettingsCache || now - homeFeedSettingsLastFetch > SETTINGS_CACHE_TTL) {
      try {
        homeFeedSettingsCache = await safeSendMessage({ type: 'GET_HOME_FEED_SETTINGS' });
        homeFeedSettingsLastFetch = now;
      } catch (e) {
        return null;
      }
    }
    return homeFeedSettingsCache;
  }

  async function processTweets() {
    // Bookmarks page: store visible tweets as bookmarks (separate pipeline),
    // not as tracked-user captures.
    if (isBookmarksPage()) {
      captureVisibleBookmarks();
      return;
    }

    const pageCheck = shouldCaptureOnPage();
    let homeFeedSettings = null;

    // If on home-like page, check the setting
    if (pageCheck.isHome) {
      homeFeedSettings = await getHomeFeedSettingsCached();
      if (!homeFeedSettings || !homeFeedSettings.enabled) {
        return; // Don't capture on home if disabled
      }
    } else if (!pageCheck.capture) {
      return; // Don't capture on this page type
    }

    const articles = qAll(document, 'tweet');
    for (const article of articles) {
      const data = extractTweetData(article);
      if (!data || processedIds.has(data.tweetId)) continue;

      processedIds.add(data.tweetId);

      // Apply threshold filters on home feed.
      // Following mode is captured without threshold filtering.
      if (pageCheck.isHome && homeFeedSettings && pageCheck.homeMode !== 'following') {
        const minLikes = homeFeedSettings.minLikes || 0;
        const minImpressions = homeFeedSettings.minImpressions || 0;

        if (minLikes > 0 && data.likeCount < minLikes) continue;
        if (minImpressions > 0 && data.impressionCount < minImpressions) continue;
      }

      safeSendMessage({
        type: 'STORE_TWEET',
        tweet: data
      }).then((response) => {
        if (response && response.blocked) {
          markBlocked(article);
        } else {
          markCaptured(article);
          // Refresh button count after capturing
          refreshButtonCount();
        }
      }).catch(() => {
        // Extension context may have been invalidated; ignore
      });
    }
  }

  // ==================== Bookmarks ====================

  const bookmarkedIds = new Set();
  let bookmarkGrabBtn = null;
  let isGrabbing = false;
  let autoGrabTriggered = false;

  function isBookmarksPage() {
    return /^\/i\/bookmarks/.test(window.location.pathname);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Extract visible bookmark tweets and store them (deduped in-session).
  // Returns the running total of unique bookmarks grabbed this session.
  function captureVisibleBookmarks() {
    if (!isBookmarksPage()) return bookmarkedIds.size;

    const articles = qAll(document, 'tweet');
    for (const article of articles) {
      const data = extractTweetData(article);
      if (!data) continue;
      if (bookmarkedIds.has(data.tweetId)) {
        markCaptured(article);
        continue;
      }
      bookmarkedIds.add(data.tweetId);
      safeSendMessage({ type: 'STORE_BOOKMARK', tweet: data })
        .then(() => markCaptured(article))
        .catch(() => {
          // Extension context may be invalidated; allow a retry later
          bookmarkedIds.delete(data.tweetId);
        });
    }
    return bookmarkedIds.size;
  }

  // Scroll the bookmarks timeline to the bottom, capturing along the way.
  // X virtualizes the list (removes offscreen rows), so we must capture on
  // every step before scrolling past.
  async function grabAllBookmarks(onProgress) {
    if (isGrabbing || !isBookmarksPage()) return bookmarkedIds.size;
    isGrabbing = true;

    let lastHeight = -1;
    let stableCount = 0;
    const MAX_STEPS = 500; // safety cap (~500 * 0.85 viewport of bookmarks)

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        captureVisibleBookmarks();
        if (onProgress) onProgress(bookmarkedIds.size);

        window.scrollBy(0, Math.floor(window.innerHeight * 0.85));
        await sleep(900); // let X render the next page of rows

        const height = document.documentElement.scrollHeight;
        const atBottom = (window.innerHeight + window.scrollY) >= height - 300;

        if (height === lastHeight && atBottom) {
          stableCount++;
          if (stableCount >= 3) break; // no growth + at bottom → done
        } else {
          stableCount = 0;
        }
        lastHeight = height;
      }
      // Final pass to catch the last screen of rows
      captureVisibleBookmarks();
      if (onProgress) onProgress(bookmarkedIds.size);
    } finally {
      isGrabbing = false;
    }

    return bookmarkedIds.size;
  }

  function ensureBookmarkButton() {
    if (!isBookmarksPage()) {
      if (bookmarkGrabBtn) bookmarkGrabBtn.style.display = 'none';
      return;
    }

    if (!bookmarkGrabBtn) {
      bookmarkGrabBtn = document.createElement('button');
      bookmarkGrabBtn.className = 'ts-bookmark-grab-btn';
      bookmarkGrabBtn.textContent = '⬇ Grab all bookmarks';
      bookmarkGrabBtn.addEventListener('click', () => startBookmarkGrab());
      document.body.appendChild(bookmarkGrabBtn);
    }
    bookmarkGrabBtn.style.display = '';
  }

  async function startBookmarkGrab() {
    if (isGrabbing || !bookmarkGrabBtn) return;
    bookmarkGrabBtn.disabled = true;

    const total = await grabAllBookmarks((count) => {
      bookmarkGrabBtn.textContent = `Grabbing… ${count} saved`;
    });

    bookmarkGrabBtn.textContent = `✓ ${total} bookmarks saved`;
    setTimeout(() => {
      if (bookmarkGrabBtn) {
        bookmarkGrabBtn.textContent = '⬇ Grab all bookmarks';
        bookmarkGrabBtn.disabled = false;
      }
    }, 3000);
  }

  // Auto-start a grab when opened from the dashboard "Sync from X" button
  // (background opens .../i/bookmarks#xvault-grab).
  function maybeAutoGrab() {
    if (autoGrabTriggered) return;
    if (isBookmarksPage() && window.location.hash.includes('xvault-grab')) {
      autoGrabTriggered = true;
      ensureBookmarkButton();
      // Give the timeline a moment to render its first rows
      setTimeout(() => startBookmarkGrab(), 1500);
    }
  }

  // Listen for real-time updates from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'TWEET_ADDED' && message.tweet.handle === currentProfileHandle) {
      refreshButtonCount();
    }
  });

  // Handle URL changes (SPA navigation)
  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      autoGrabTriggered = false; // allow auto-grab again on re-navigation
      setTimeout(() => {
        checkProfile();
        ensureBookmarkButton();
        maybeAutoGrab();
      }, 500); // Wait for page to render
    }
  });

  // Initial setup
  createFloatingButton();
  ensureBookmarkButton();
  setTimeout(checkProfile, 1000); // Initial profile check
  setTimeout(maybeAutoGrab, 1000); // Auto-grab if opened via dashboard sync

  // Initial scan
  processTweets();

  // Observe DOM for new tweets (infinite scroll, SPA navigation)
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      processTweets();
      checkProfile();
      ensureBookmarkButton();
    }, 300);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  urlObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
})();
