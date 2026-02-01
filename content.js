(() => {
  const processedIds = new Set();
  let debounceTimer = null;

  // Inject styles for the captured badge
  const style = document.createElement('style');
  style.textContent = `
    .ts-captured-badge {
      position: absolute;
      top: 4px;
      right: 4px;
      background: #1DA1F2;
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
  `;
  document.head.appendChild(style);

  function markCaptured(article) {
    if (article.querySelector('.ts-captured-badge') || article.querySelector('.ts-blocked-badge')) return;
    article.style.position = 'relative';
    const badge = document.createElement('div');
    badge.className = 'ts-captured-badge';
    badge.textContent = 'CAPTURED';
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
    // Find the status link to get handle and tweet ID
    const statusLink = article.querySelector('a[href*="/status/"]');
    if (!statusLink) return null;

    const href = statusLink.getAttribute('href');
    const parts = href.split('/');
    const statusIdx = parts.indexOf('status');
    if (statusIdx === -1 || statusIdx < 1) return null;

    const handle = parts[statusIdx - 1].toLowerCase();
    const tweetId = parts[statusIdx + 1];
    if (!tweetId || !/^\d+$/.test(tweetId)) return null;

    // Timestamp
    const timeEl = article.querySelector('time[datetime]');
    const timestamp = timeEl ? timeEl.getAttribute('datetime') : new Date().toISOString();

    // Tweet text
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const fullText = textEl ? textEl.innerText : '';

    // Display name and handle from User-Name
    const userNameEl = article.querySelector('[data-testid="User-Name"]');
    let displayName = '';
    if (userNameEl) {
      const nameLink = userNameEl.querySelector('a');
      if (nameLink) {
        // The first text node or span in the link is the display name
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
    const avatarImg = article.querySelector('img[src*="profile_images"]');
    const avatarUrl = avatarImg ? avatarImg.getAttribute('src') : '';

    // Detect retweet
    const socialContext = article.querySelector('[data-testid="socialContext"]');
    let isRetweet = false;
    let retweetedBy = null;
    if (socialContext && socialContext.textContent.toLowerCase().includes('reposted')) {
      isRetweet = true;
      // The current page user or the name in the social context is the retweeter
      const retweeterLink = socialContext.querySelector('a[href^="/"]');
      if (retweeterLink) {
        retweetedBy = retweeterLink.getAttribute('href').replace('/', '').toLowerCase();
      }
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
      retweetedBy
    };
  }

  function processTweets() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const article of articles) {
      const data = extractTweetData(article);
      if (!data || processedIds.has(data.tweetId)) continue;

      processedIds.add(data.tweetId);

      chrome.runtime.sendMessage({
        type: 'STORE_TWEET',
        tweet: data
      }).then((response) => {
        if (response && response.blocked) {
          markBlocked(article);
        } else {
          markCaptured(article);
        }
      }).catch(() => {
        // Extension context may have been invalidated; ignore
      });
    }
  }

  // Initial scan
  processTweets();

  // Observe DOM for new tweets (infinite scroll, SPA navigation)
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processTweets, 300);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
})();
