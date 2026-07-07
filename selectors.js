/**
 * X-Vault DOM Selectors — centralised primary + fallback selectors
 * for resilience against Twitter/X DOM changes.
 *
 * Loaded as a plain script before content.js (not an ES module).
 * Exposes window.XVaultSelectors for use in content.js.
 */
(() => {
    const SELECTORS = {
        tweet: { primary: 'article[data-testid="tweet"]', fallbacks: ['article[role="article"]'] },
        tweetText: { primary: '[data-testid="tweetText"]', fallbacks: ['div[lang]'] },
        statusLink: { primary: 'a[href*="/status/"]', fallbacks: [] },
        time: { primary: 'time[datetime]', fallbacks: [] },
        userName: { primary: '[data-testid="User-Name"]', fallbacks: [] },
        avatar: { primary: 'img[src*="profile_images"]', fallbacks: ['img[src*="pbs.twimg.com"]'] },
        socialContext: { primary: '[data-testid="socialContext"]', fallbacks: [] },
        profilePhoto: { primary: 'a[href$="/photo"] img[src*="profile_images"]', fallbacks: ['img[src*="profile_images"]'] },
        reply: { primary: '[data-testid="reply"]', fallbacks: [] },
        retweet: { primary: '[data-testid="retweet"]', fallbacks: ['[data-testid="unretweet"]'] },
        like: { primary: '[data-testid="like"]', fallbacks: ['[data-testid="unlike"]'] },
        bookmark: { primary: '[data-testid="bookmark"]', fallbacks: ['[data-testid="removeBookmark"]'] },
        cardWrapper: { primary: '[data-testid="card.wrapper"]', fallbacks: [] },
        analyticsLink: { primary: 'a[href*="/analytics"]', fallbacks: [] },
        actionGroup: { primary: '[role="group"]', fallbacks: [] },
    };

    /** Query a single element using primary + fallback selectors */
    function q(el, key) {
        const s = SELECTORS[key];
        if (!s) return el.querySelector(key); // raw selector fallback
        let result = el.querySelector(s.primary);
        if (!result) {
            for (const fb of s.fallbacks) {
                result = el.querySelector(fb);
                if (result) break;
            }
        }
        return result;
    }

    /** Query all elements using primary + fallback selectors */
    function qAll(el, key) {
        const s = SELECTORS[key];
        if (!s) return el.querySelectorAll(key);
        let result = el.querySelectorAll(s.primary);
        if (result.length === 0) {
            for (const fb of s.fallbacks) {
                result = el.querySelectorAll(fb);
                if (result.length > 0) break;
            }
        }
        return result;
    }

    window.XVaultSelectors = { SELECTORS, q, qAll };
})();
