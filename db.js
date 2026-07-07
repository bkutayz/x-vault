const DB_NAME = 'TwitterScrapeDB';
const DB_VERSION = 9;

let dbInstance = null;

export function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const tx = event.target.transaction;

      if (!db.objectStoreNames.contains('tweets')) {
        const tweetStore = db.createObjectStore('tweets', { keyPath: 'tweetId' });
        tweetStore.createIndex('byUser', 'handle', { unique: false });
        tweetStore.createIndex('byTimestamp', 'timestamp', { unique: false });
        tweetStore.createIndex('byUserAndTime', ['handle', 'timestamp'], { unique: false });
      }

      if (!db.objectStoreNames.contains('users')) {
        const userStore = db.createObjectStore('users', { keyPath: 'handle' });
        // V4: Add index for sorted retrieval (starred desc, tweetCount desc)
        userStore.createIndex('bySortOrder', ['starred', 'tweetCount'], { unique: false });
      } else if (event.oldVersion < 4) {
        // Add index to existing store
        const userStore = tx.objectStore('users');
        if (!userStore.indexNames.contains('bySortOrder')) {
          userStore.createIndex('bySortOrder', ['starred', 'tweetCount'], { unique: false });
        }
      }

      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }

      // V3: Add dedicated blockedUsers store for O(1) lookup
      if (!db.objectStoreNames.contains('blockedUsers')) {
        db.createObjectStore('blockedUsers', { keyPath: 'handle' });

        // Migrate existing blocked users from settings array
        if (event.oldVersion < 3 && event.oldVersion > 0) {
          const settingsStore = tx.objectStore('settings');
          const getReq = settingsStore.get('blockedUsers');
          getReq.onsuccess = () => {
            const oldBlocked = getReq.result?.value || [];
            if (oldBlocked.length > 0) {
              const blockedStore = tx.objectStore('blockedUsers');
              for (const handle of oldBlocked) {
                blockedStore.put({ handle, blockedAt: new Date().toISOString() });
              }
              // Clean up old settings entry
              settingsStore.delete('blockedUsers');
            }
          };
        }
      }

      // V5: Add inverted index for fast text search
      // Structure: { word: string, tweetIds: string[] }
      if (!db.objectStoreNames.contains('searchIndex')) {
        db.createObjectStore('searchIndex', { keyPath: 'word' });
      }

      // V6: Add index for fetching recently captured tweets
      if (event.oldVersion < 6) {
        const tweetStore = db.objectStoreNames.contains('tweets')
          ? tx.objectStore('tweets')
          : null;
        if (tweetStore && !tweetStore.indexNames.contains('byCapturedAt')) {
          tweetStore.createIndex('byCapturedAt', 'capturedAt', { unique: false });
        }
      }

      // V7: Add blogPosts object store for user blog posts
      if (!db.objectStoreNames.contains('blogPosts')) {
        const blogStore = db.createObjectStore('blogPosts', { keyPath: 'postId' });
        blogStore.createIndex('byUser', 'handle', { unique: false });
        blogStore.createIndex('byUserAndTime', ['handle', 'createdAt'], { unique: false });
      }

      // V8: Add tweetTags store for tags/collections
      if (!db.objectStoreNames.contains('tweetTags')) {
        const tagStore = db.createObjectStore('tweetTags', { autoIncrement: true });
        tagStore.createIndex('byTweetId', 'tweetId', { unique: false });
        tagStore.createIndex('byTag', 'tag', { unique: false });
        tagStore.createIndex('byTweetAndTag', ['tweetId', 'tag'], { unique: true });
      }

      // V9: Add bookmarks store for synced X bookmarks (independent of capture pipeline)
      if (!db.objectStoreNames.contains('bookmarks')) {
        const bookmarkStore = db.createObjectStore('bookmarks', { keyPath: 'tweetId' });
        bookmarkStore.createIndex('bySavedAt', 'savedAt', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      dbInstance.onclose = () => { dbInstance = null; };
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

// --- Settings helpers ---

async function getSetting(key, defaultValue) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readonly');
    const req = tx.objectStore('settings').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : defaultValue);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function setSetting(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readwrite');
    const req = tx.objectStore('settings').put({ key, value });
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

function normalizeUserQuickTag(tag) {
  if (!tag) return '';
  return String(tag)
    .toLowerCase()
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 32);
}

function sanitizeUserQuickTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const result = [];

  for (const tag of tags) {
    const normalized = normalizeUserQuickTag(tag);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function normalizeTweetCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

// --- Blocked users (O(1) lookup via dedicated store) ---

export async function getBlockedUsers() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blockedUsers', 'readonly');
    const req = tx.objectStore('blockedUsers').getAll();
    req.onsuccess = () => resolve(req.result.map(r => r.handle));
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function blockUser(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blockedUsers', 'readwrite');
    const req = tx.objectStore('blockedUsers').put({
      handle,
      blockedAt: new Date().toISOString()
    });
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function unblockUser(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blockedUsers', 'readwrite');
    const req = tx.objectStore('blockedUsers').delete(handle);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function isBlocked(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blockedUsers', 'readonly');
    const req = tx.objectStore('blockedUsers').get(handle);
    req.onsuccess = () => resolve(!!req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

// --- Home Feed Settings ---

const DEFAULT_HOME_FEED_SETTINGS = {
  enabled: false,
  minLikes: 0,
  minImpressions: 0
};

export async function getHomeFeedSettings() {
  return getSetting('homeFeedSettings', DEFAULT_HOME_FEED_SETTINGS);
}

export async function setHomeFeedSettings(settings) {
  await setSetting('homeFeedSettings', {
    ...DEFAULT_HOME_FEED_SETTINGS,
    ...settings
  });
}

// --- AI Settings ---

const DEFAULT_AI_SETTINGS = {
  apiKey: '',
  model: 'gpt-4o-mini',
  systemPrompt: 'You generate concise Twitter/X replies that match the provided writing style samples. Prioritize natural voice matching and relevance over forced humor.'
};

export async function getAISettings() {
  return getSetting('aiSettings', DEFAULT_AI_SETTINGS);
}

export async function setAISettings(settings) {
  await setSetting('aiSettings', {
    ...DEFAULT_AI_SETTINGS,
    ...settings
  });
}

// --- Auto-Backup Settings ---

const DEFAULT_AUTO_BACKUP_SETTINGS = {
  enabled: false,
  intervalHours: 24,
  lastBackupAt: null
};

export async function getAutoBackupSettings() {
  return getSetting('autoBackupSettings', DEFAULT_AUTO_BACKUP_SETTINGS);
}

export async function setAutoBackupSettings(settings) {
  await setSetting('autoBackupSettings', {
    ...DEFAULT_AUTO_BACKUP_SETTINGS,
    ...settings
  });
}

// Legacy compatibility
export async function getCaptureFromHome() {
  const settings = await getHomeFeedSettings();
  return settings.enabled;
}

export async function setCaptureFromHome(enabled) {
  const current = await getHomeFeedSettings();
  await setHomeFeedSettings({ ...current, enabled });
}

// --- Starred users ---

export async function getStarredUsers() {
  return getSetting('starredUsers', []);
}

export async function starUser(handle) {
  const starred = await getStarredUsers();
  if (!starred.includes(handle)) {
    starred.push(handle);
    await setSetting('starredUsers', starred);
  }
}

export async function unstarUser(handle) {
  const starred = await getStarredUsers();
  const filtered = starred.filter(h => h !== handle);
  await setSetting('starredUsers', filtered);
}

// --- Search Index Helpers ---

// Tokenize text into searchable words (lowercase, min 2 chars)
function tokenizeText(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s@]/g, ' ')  // Replace punctuation with spaces
    .split(/\s+/)
    .filter(word => word.length >= 2)  // Min 2 chars
    .filter((word, i, arr) => arr.indexOf(word) === i);  // Unique
}

// Add tweetId to search index for given words
async function indexTweetWords(db, tweetId, words) {
  if (words.length === 0) return;

  return new Promise((resolve, reject) => {
    const tx = db.transaction('searchIndex', 'readwrite');
    const store = tx.objectStore('searchIndex');
    let pending = words.length;

    for (const word of words) {
      const getReq = store.get(word);
      getReq.onsuccess = () => {
        const existing = getReq.result || { word, tweetIds: [] };
        if (!existing.tweetIds.includes(tweetId)) {
          existing.tweetIds.push(tweetId);
          store.put(existing);
        }
        pending--;
        if (pending === 0) resolve();
      };
      getReq.onerror = (e) => reject(e.target.error);
    }

    tx.onerror = (e) => reject(e.target.error);
  });
}

// Remove tweetId from search index for given words
async function unindexTweetWords(db, tweetId, words) {
  if (words.length === 0) return;

  return new Promise((resolve, reject) => {
    const tx = db.transaction('searchIndex', 'readwrite');
    const store = tx.objectStore('searchIndex');
    let pending = words.length;

    for (const word of words) {
      const getReq = store.get(word);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (existing) {
          existing.tweetIds = existing.tweetIds.filter(id => id !== tweetId);
          if (existing.tweetIds.length === 0) {
            store.delete(word);
          } else {
            store.put(existing);
          }
        }
        pending--;
        if (pending === 0) resolve();
      };
      getReq.onerror = (e) => reject(e.target.error);
    }

    tx.onerror = (e) => reject(e.target.error);
  });
}

// --- Tweets ---

export async function storeTweet(tweet) {
  const db = await openDB();

  // Check if already exists
  const existing = await new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const req = tx.objectStore('tweets').get(tweet.tweetId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = (e) => reject(e.target.error);
  });

  if (existing) {
    // Update if existing record is missing text or engagement metrics
    const needsUpdate = (!existing.fullText && tweet.fullText) ||
      (!existing.viewCount && tweet.viewCount) ||
      (!existing.retweetCount && tweet.retweetCount) ||
      (!existing.replyCount && tweet.replyCount) ||
      (!existing.bookmarkCount && tweet.bookmarkCount);

    if (needsUpdate) {
      const merged = { ...existing, ...tweet, capturedAt: existing.capturedAt };
      // Keep existing non-empty text
      if (existing.fullText) merged.fullText = existing.fullText;
      await new Promise((resolve, reject) => {
        const tx = db.transaction('tweets', 'readwrite');
        const req = tx.objectStore('tweets').put(merged);
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e.target.error);
      });
      // Re-index if text was added
      if (!existing.fullText && tweet.fullText) {
        try {
          if (db.objectStoreNames.contains('searchIndex')) {
            const words = tokenizeText(`${merged.fullText} ${merged.handle} ${merged.displayName}`);
            await indexTweetWords(db, merged.tweetId, words);
          }
        } catch (e) {
          console.warn('[X-Vault] Search indexing failed (non-critical):', e);
        }
      }
      return { inserted: false, updated: true };
    }
    return { inserted: false };
  }

  // Store the tweet
  await new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readwrite');
    const req = tx.objectStore('tweets').put(tweet);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });

  // Index the tweet text for search (non-blocking - don't fail if indexing fails)
  try {
    if (db.objectStoreNames.contains('searchIndex')) {
      const words = tokenizeText(`${tweet.fullText} ${tweet.handle} ${tweet.displayName}`);
      await indexTweetWords(db, tweet.tweetId, words);
    }
  } catch (e) {
    console.warn('[X-Vault] Search indexing failed (non-critical):', e);
  }

  return { inserted: true };
}

export async function deleteTweet(tweetId) {
  const db = await openDB();

  // Get the tweet first to extract words for unindexing
  const tweet = await new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const req = tx.objectStore('tweets').get(tweetId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  // Delete the tweet
  await new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readwrite');
    const req = tx.objectStore('tweets').delete(tweetId);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });

  // Remove from search index (non-blocking)
  try {
    if (tweet && db.objectStoreNames.contains('searchIndex')) {
      const words = tokenizeText(`${tweet.fullText} ${tweet.handle} ${tweet.displayName}`);
      await unindexTweetWords(db, tweetId, words);
    }
  } catch (e) {
    console.warn('[X-Vault] Search unindexing failed (non-critical):', e);
  }
}

// --- Users ---

// Increment tweet count by delta (use 1 for new tweet, -1 for delete)
export async function adjustUserTweetCount(handle, delta) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readwrite');
    const store = tx.objectStore('users');
    const getReq = store.get(handle);

    getReq.onsuccess = () => {
      if (!getReq.result) {
        resolve(null); // User doesn't exist
        return;
      }
      const record = { ...getReq.result };
      record.tweetCount = Math.max(0, normalizeTweetCount(record.tweetCount) + delta);
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve(record);
      putReq.onerror = (e) => reject(e.target.error);
    };
    getReq.onerror = (e) => reject(e.target.error);
  });
}

// Store or update user. If skipCount is true, preserves existing tweetCount (O(1)).
// If skipCount is false or user is new, recounts tweets (O(log n + k)).
export async function storeUser(user, { skipCount = false } = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['users', 'tweets'], 'readwrite');
    const userStore = tx.objectStore('users');
    const tweetStore = tx.objectStore('tweets');

    const getReq = userStore.get(user.handle);
    getReq.onsuccess = () => {
      const existing = getReq.result || {};
      const isNewUser = !getReq.result;

      // Only count tweets if: new user OR explicitly requested
      if (!skipCount || isNewUser) {
        const index = tweetStore.index('byUser');
        const countReq = index.count(IDBKeyRange.only(user.handle));

        countReq.onsuccess = () => {
          const record = {
            handle: user.handle,
            displayName: user.displayName || existing.displayName || '',
            avatarUrl: user.avatarUrl || existing.avatarUrl || '',
            lastSeen: user.lastSeen || existing.lastSeen,
            tweetCount: countReq.result,
            starred: existing.starred || false,
            notes: existing.notes || '',
            quickTags: sanitizeUserQuickTags([
              ...(existing.quickTags || []),
              ...(user.quickTags || [])
            ])
          };
          const putReq = userStore.put(record);
          putReq.onsuccess = () => resolve(record);
          putReq.onerror = (e) => reject(e.target.error);
        };
        countReq.onerror = (e) => reject(e.target.error);
      } else {
        // Skip count: just update metadata, preserve existing tweetCount
        const record = {
          handle: user.handle,
          displayName: user.displayName || existing.displayName || '',
          avatarUrl: user.avatarUrl || existing.avatarUrl || '',
          lastSeen: user.lastSeen || existing.lastSeen,
          tweetCount: normalizeTweetCount(existing.tweetCount),
          starred: existing.starred || false,
          notes: existing.notes || '',
          quickTags: sanitizeUserQuickTags([
            ...(existing.quickTags || []),
            ...(user.quickTags || [])
          ])
        };
        const putReq = userStore.put(record);
        putReq.onsuccess = () => resolve(record);
        putReq.onerror = (e) => reject(e.target.error);
      }
    };
    getReq.onerror = (e) => reject(e.target.error);
  });
}

export async function deleteUserAndTweets(handle) {
  const db = await openDB();

  // First, collect all tweet IDs for this user in a read transaction
  const tweetIds = await new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const index = tx.objectStore('tweets').index('byUser');
    const req = index.getAllKeys(IDBKeyRange.only(handle));
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  // Collect all blog post IDs for this user
  const postIds = await new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains('blogPosts')) {
      resolve([]);
      return;
    }
    const tx = db.transaction('blogPosts', 'readonly');
    const index = tx.objectStore('blogPosts').index('byUser');
    const req = index.getAllKeys(IDBKeyRange.only(handle));
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  // Then delete user + all tweets + all blog posts in a write transaction
  const stores = ['users', 'tweets'];
  if (db.objectStoreNames.contains('blogPosts')) {
    stores.push('blogPosts');
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    tx.objectStore('users').delete(handle);
    const tweetStore = tx.objectStore('tweets');
    for (const id of tweetIds) {
      tweetStore.delete(id);
    }
    if (db.objectStoreNames.contains('blogPosts')) {
      const postStore = tx.objectStore('blogPosts');
      for (const id of postIds) {
        postStore.delete(id);
      }
    }
    tx.oncomplete = () => resolve({ deletedTweets: tweetIds.length, deletedPosts: postIds.length });
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function updateUserNotes(handle, notes) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readwrite');
    const store = tx.objectStore('users');
    const getReq = store.get(handle);
    getReq.onsuccess = () => {
      if (!getReq.result) { resolve(); return; }
      const record = { ...getReq.result, notes };
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve(record);
      putReq.onerror = (e) => reject(e.target.error);
    };
    getReq.onerror = (e) => reject(e.target.error);
  });
}

export async function setUserStarred(handle, starred) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readwrite');
    const store = tx.objectStore('users');
    const getReq = store.get(handle);
    getReq.onsuccess = () => {
      if (!getReq.result) { resolve(); return; }
      const record = { ...getReq.result, starred };
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve(record);
      putReq.onerror = (e) => reject(e.target.error);
    };
    getReq.onerror = (e) => reject(e.target.error);
  });
}

export async function getAllUsers() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readonly');
    const store = tx.objectStore('users');

    // Use getAll with in-memory sort for reliability
    // (existing records may not have all indexed fields populated)
    const req = store.getAll();
    req.onsuccess = () => {
      const users = req.result.map((user) => ({
        ...user,
        quickTags: sanitizeUserQuickTags(user.quickTags)
      })).sort((a, b) => {
        // Starred first, then by tweet count
        if (a.starred && !b.starred) return -1;
        if (!a.starred && b.starred) return 1;
        return normalizeTweetCount(b.tweetCount) - normalizeTweetCount(a.tweetCount);
      });
      resolve(users);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function getUser(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readonly');
    const req = tx.objectStore('users').get(handle);
    req.onsuccess = () => {
      if (!req.result) {
        resolve(null);
        return;
      }
      resolve({
        ...req.result,
        quickTags: sanitizeUserQuickTags(req.result.quickTags)
      });
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function addQuickTagToUser(handle, tag) {
  const db = await openDB();
  const normalizedTag = normalizeUserQuickTag(tag);
  if (!normalizedTag) return { added: false, invalid: true };

  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readwrite');
    const store = tx.objectStore('users');
    const getReq = store.get(handle);

    getReq.onsuccess = () => {
      if (!getReq.result) {
        resolve({ added: false, userMissing: true });
        return;
      }

      const record = { ...getReq.result };
      const quickTags = sanitizeUserQuickTags(record.quickTags);
      if (quickTags.includes(normalizedTag)) {
        resolve({ added: false, exists: true, tag: normalizedTag, quickTags });
        return;
      }

      record.quickTags = [...quickTags, normalizedTag];
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve({ added: true, tag: normalizedTag, quickTags: record.quickTags });
      putReq.onerror = (e) => reject(e.target.error);
    };
    getReq.onerror = (e) => reject(e.target.error);
  });
}

export async function removeQuickTagFromUser(handle, tag) {
  const db = await openDB();
  const normalizedTag = normalizeUserQuickTag(tag);
  if (!normalizedTag) return { removed: false, invalid: true };

  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readwrite');
    const store = tx.objectStore('users');
    const getReq = store.get(handle);

    getReq.onsuccess = () => {
      if (!getReq.result) {
        resolve({ removed: false, userMissing: true });
        return;
      }

      const record = { ...getReq.result };
      const quickTags = sanitizeUserQuickTags(record.quickTags);
      const filtered = quickTags.filter(t => t !== normalizedTag);

      if (filtered.length === quickTags.length) {
        resolve({ removed: false, missing: true, quickTags });
        return;
      }

      record.quickTags = filtered;
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve({ removed: true, tag: normalizedTag, quickTags: filtered });
      putReq.onerror = (e) => reject(e.target.error);
    };
    getReq.onerror = (e) => reject(e.target.error);
  });
}

export async function getQuickTagsForUser(handle) {
  const user = await getUser(handle);
  return sanitizeUserQuickTags(user?.quickTags);
}

export async function getAllQuickUserTags() {
  const users = await getAllUsers();
  const tagCounts = {};

  for (const user of users) {
    const tags = sanitizeUserQuickTags(user.quickTags);
    for (const tag of tags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }

  return Object.entries(tagCounts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export async function getTweetsByUser(handle, { limit = 50, offset = 0 } = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const store = tx.objectStore('tweets');
    const index = store.index('byUserAndTime');

    const range = IDBKeyRange.bound(
      [handle, ''],
      [handle, '\uffff']
    );

    const results = [];
    let skipped = 0;
    const req = index.openCursor(range, 'prev');

    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor || results.length >= limit) {
        resolve(results);
        return;
      }
      if (skipped < offset) {
        skipped++;
        cursor.continue();
        return;
      }
      results.push(cursor.value);
      cursor.continue();
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

// Parse advanced search operators from query string
// Supports: from:handle, before:YYYY-MM-DD, after:YYYY-MM-DD, min:likes:N, min:views:N
function parseSearchQuery(query) {
  const filters = {};
  let textParts = [];

  const tokens = query.match(/\S+/g) || [];
  for (const token of tokens) {
    const lower = token.toLowerCase();

    if (lower.startsWith('from:')) {
      filters.fromHandle = lower.slice(5).replace(/^@/, '');
    } else if (lower.startsWith('before:')) {
      filters.beforeDate = token.slice(7); // keep original case for date
    } else if (lower.startsWith('after:')) {
      filters.afterDate = token.slice(6);
    } else if (lower.startsWith('min:likes:')) {
      filters.minLikes = parseInt(lower.slice(10), 10) || 0;
    } else if (lower.startsWith('min:views:')) {
      filters.minViews = parseInt(lower.slice(10), 10) || 0;
    } else if (lower.startsWith('has:media')) {
      filters.hasMedia = true;
    } else {
      textParts.push(token);
    }
  }

  return { text: textParts.join(' ').trim(), filters };
}

function matchesFilters(tweet, filters) {
  if (filters.fromHandle && tweet.handle.toLowerCase() !== filters.fromHandle) return false;
  if (filters.beforeDate && tweet.timestamp > filters.beforeDate) return false;
  if (filters.afterDate && tweet.timestamp < filters.afterDate) return false;
  if (filters.minLikes && (tweet.likeCount || 0) < filters.minLikes) return false;
  if (filters.minViews && (tweet.viewCount || tweet.impressionCount || 0) < filters.minViews) return false;
  if (filters.hasMedia && (!tweet.mediaUrls || tweet.mediaUrls.length === 0)) return false;
  return true;
}

export async function searchTweets(query, { limit = 100 } = {}) {
  const db = await openDB();
  const { text, filters } = parseSearchQuery(query);
  const hasFilters = Object.keys(filters).length > 0;
  const lowerText = text.toLowerCase();

  // Tokenize the text portion for index lookup
  const queryTokens = tokenizeText(lowerText);

  // If we have text tokens, try fast index lookup first
  if (queryTokens.length > 0 && db.objectStoreNames.contains('searchIndex')) {
    try {
      const tokenResults = await Promise.all(
        queryTokens.map(token => new Promise((resolve, reject) => {
          const tx = db.transaction('searchIndex', 'readonly');
          const req = tx.objectStore('searchIndex').get(token);
          req.onsuccess = () => resolve(req.result?.tweetIds || []);
          req.onerror = (e) => reject(e.target.error);
        }))
      );

      let matchingIds = tokenResults[0] || [];
      for (let i = 1; i < tokenResults.length; i++) {
        const nextIds = new Set(tokenResults[i]);
        matchingIds = matchingIds.filter(id => nextIds.has(id));
      }

      if (matchingIds.length > 0) {
        const tweets = await Promise.all(
          matchingIds.map(tweetId => new Promise((resolve, reject) => {
            const tx = db.transaction('tweets', 'readonly');
            const req = tx.objectStore('tweets').get(tweetId);
            req.onsuccess = () => resolve(req.result);
            req.onerror = (e) => reject(e.target.error);
          }))
        );
        const filtered = tweets.filter(t => t && (!hasFilters || matchesFilters(t, filters)));
        return filtered.slice(0, limit);
      }
    } catch (e) {
      console.warn('[X-Vault] Index search failed, falling back to scan:', e);
    }
  }

  // Full scan: for partial matches, filter-only queries, or when index unavailable
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const store = tx.objectStore('tweets');
    const results = [];
    const req = store.openCursor();

    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor || results.length >= limit) {
        resolve(results);
        return;
      }
      const tweet = cursor.value;

      // Apply operator filters first
      if (hasFilters && !matchesFilters(tweet, filters)) {
        cursor.continue();
        return;
      }

      // Text matching (skip if no text query)
      if (lowerText) {
        if (
          (tweet.fullText || '').toLowerCase().includes(lowerText) ||
          tweet.handle.toLowerCase().includes(lowerText) ||
          (tweet.displayName || '').toLowerCase().includes(lowerText)
        ) {
          results.push(tweet);
        }
      } else if (hasFilters) {
        // Filter-only query (no text), just add matching tweets
        results.push(tweet);
      }

      cursor.continue();
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function getTweetCount() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const store = tx.objectStore('tweets');
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function getTweetCountByUser(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const index = tx.objectStore('tweets').index('byUser');
    const req = index.count(IDBKeyRange.only(handle));
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function getRecentTweets({ limit = 50 } = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const store = tx.objectStore('tweets');

    // Use byCapturedAt index if available, otherwise fall back to full scan
    if (store.indexNames.contains('byCapturedAt')) {
      const index = store.index('byCapturedAt');
      const results = [];
      const req = index.openCursor(null, 'prev');

      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor || results.length >= limit) {
          resolve(results);
          return;
        }
        results.push(cursor.value);
        cursor.continue();
      };
      req.onerror = (e) => reject(e.target.error);
    } else {
      // Fallback: get all and sort in memory
      const req = store.getAll();
      req.onsuccess = () => {
        const tweets = req.result
          .sort((a, b) => (b.capturedAt || '').localeCompare(a.capturedAt || ''))
          .slice(0, limit);
        resolve(tweets);
      };
      req.onerror = (e) => reject(e.target.error);
    }
  });
}

export async function getAllTweetsForUser(handle) {
  return getTweetsByUser(handle, { limit: Infinity, offset: 0 });
}

// --- Tags / Collections ---

export async function addTagToTweet(tweetId, tag) {
  const db = await openDB();
  const normalizedTag = tag.toLowerCase().trim();

  return new Promise((resolve, reject) => {
    const tx = db.transaction('tweetTags', 'readwrite');
    const store = tx.objectStore('tweetTags');

    // Check if already tagged
    const idx = store.index('byTweetAndTag');
    const checkReq = idx.get([tweetId, normalizedTag]);
    checkReq.onsuccess = () => {
      if (checkReq.result) {
        resolve({ added: false, exists: true });
        return;
      }
      const addReq = store.add({ tweetId, tag: normalizedTag, taggedAt: new Date().toISOString() });
      addReq.onsuccess = () => resolve({ added: true });
      addReq.onerror = (e) => reject(e.target.error);
    };
    checkReq.onerror = (e) => reject(e.target.error);
  });
}

export async function removeTagFromTweet(tweetId, tag) {
  const db = await openDB();
  const normalizedTag = tag.toLowerCase().trim();

  return new Promise((resolve, reject) => {
    const tx = db.transaction('tweetTags', 'readwrite');
    const store = tx.objectStore('tweetTags');
    const idx = store.index('byTweetAndTag');
    const req = idx.openCursor(IDBKeyRange.only([tweetId, normalizedTag]));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        resolve({ removed: true });
      } else {
        resolve({ removed: false });
      }
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function getTagsForTweet(tweetId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tweetTags', 'readonly');
    const idx = tx.objectStore('tweetTags').index('byTweetId');
    const req = idx.getAll(IDBKeyRange.only(tweetId));
    req.onsuccess = () => resolve(req.result.map(r => r.tag));
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function getTweetsByTag(tag) {
  const db = await openDB();
  const normalizedTag = tag.toLowerCase().trim();

  // Get all tweetIds with this tag
  const tagRecords = await new Promise((resolve, reject) => {
    const tx = db.transaction('tweetTags', 'readonly');
    const idx = tx.objectStore('tweetTags').index('byTag');
    const req = idx.getAll(IDBKeyRange.only(normalizedTag));
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  if (tagRecords.length === 0) return [];

  // Fetch the actual tweets
  const tweets = await Promise.all(
    tagRecords.map(r => new Promise((resolve, reject) => {
      const tx = db.transaction('tweets', 'readonly');
      const req = tx.objectStore('tweets').get(r.tweetId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    }))
  );

  return tweets.filter(Boolean);
}

export async function getAllTags() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tweetTags', 'readonly');
    const store = tx.objectStore('tweetTags');
    const req = store.getAll();
    req.onsuccess = () => {
      // Count occurrences of each tag
      const tagCounts = {};
      for (const r of req.result) {
        tagCounts[r.tag] = (tagCounts[r.tag] || 0) + 1;
      }
      // Return sorted by count descending
      const tags = Object.entries(tagCounts)
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count);
      resolve(tags);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

// --- Bookmarks (synced from X, stored independently of captured tweets) ---

export async function storeBookmark(tweet) {
  const db = await openDB();

  // Preserve original savedAt if this bookmark was already synced
  const existing = await new Promise((resolve, reject) => {
    const tx = db.transaction('bookmarks', 'readonly');
    const req = tx.objectStore('bookmarks').get(tweet.tweetId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = (e) => reject(e.target.error);
  });

  const now = new Date().toISOString();
  const record = {
    ...tweet,
    savedAt: existing?.savedAt || now,
    updatedAt: now
  };

  await new Promise((resolve, reject) => {
    const tx = db.transaction('bookmarks', 'readwrite');
    const req = tx.objectStore('bookmarks').put(record);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });

  return { inserted: !existing, tweetId: tweet.tweetId };
}

export async function getAllBookmarks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('bookmarks', 'readonly');
    const req = tx.objectStore('bookmarks').getAll();
    req.onsuccess = () => {
      // Newest tweet first (ISO timestamps sort lexicographically)
      const rows = req.result.sort((a, b) =>
        (b.timestamp || '').localeCompare(a.timestamp || ''));
      resolve(rows);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function getBookmarkCount() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('bookmarks', 'readonly');
    const req = tx.objectStore('bookmarks').count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function deleteBookmark(tweetId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('bookmarks', 'readwrite');
    const req = tx.objectStore('bookmarks').delete(tweetId);
    req.onsuccess = () => resolve({ deleted: true });
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function clearBookmarks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('bookmarks', 'readwrite');
    const req = tx.objectStore('bookmarks').clear();
    req.onsuccess = () => resolve({ cleared: true });
    req.onerror = (e) => reject(e.target.error);
  });
}

// --- Capture Stats (for analytics) ---

export async function getCaptureStats() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const store = tx.objectStore('tweets');

    // Count tweets per day for last 30 days
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const dailyCounts = {};

    const req = store.index('byCapturedAt').openCursor(IDBKeyRange.lowerBound(thirtyDaysAgo));
    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        // Convert to array sorted by date
        const result = Object.entries(dailyCounts)
          .map(([date, count]) => ({ date, count }))
          .sort((a, b) => a.date.localeCompare(b.date));
        resolve(result);
        return;
      }
      const capturedAt = cursor.value.capturedAt || cursor.value.timestamp;
      if (capturedAt) {
        const day = capturedAt.substring(0, 10); // YYYY-MM-DD
        dailyCounts[day] = (dailyCounts[day] || 0) + 1;
      }
      cursor.continue();
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

// --- Blog Posts ---

// Generate unique post ID
function generatePostId() {
  return `post_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export async function storeBlogPost(post) {
  const db = await openDB();
  const now = new Date().toISOString();

  const record = {
    postId: post.postId || generatePostId(),
    handle: post.handle,
    title: post.title || '',
    content: post.content || '',
    createdAt: post.createdAt || now,
    updatedAt: now
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction('blogPosts', 'readwrite');
    const store = tx.objectStore('blogPosts');
    const req = store.put(record);
    req.onsuccess = () => resolve(record);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function getBlogPostsByUser(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blogPosts', 'readonly');
    const store = tx.objectStore('blogPosts');
    const index = store.index('byUserAndTime');

    const range = IDBKeyRange.bound(
      [handle, ''],
      [handle, '\uffff']
    );

    const results = [];
    const req = index.openCursor(range, 'prev'); // newest first

    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        resolve(results);
        return;
      }
      results.push(cursor.value);
      cursor.continue();
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function getBlogPost(postId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blogPosts', 'readonly');
    const req = tx.objectStore('blogPosts').get(postId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function updateBlogPost(postId, updates) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blogPosts', 'readwrite');
    const store = tx.objectStore('blogPosts');
    const getReq = store.get(postId);

    getReq.onsuccess = () => {
      if (!getReq.result) {
        resolve(null);
        return;
      }
      const record = {
        ...getReq.result,
        ...updates,
        postId, // ensure postId is not overwritten
        updatedAt: new Date().toISOString()
      };
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve(record);
      putReq.onerror = (e) => reject(e.target.error);
    };
    getReq.onerror = (e) => reject(e.target.error);
  });
}

export async function deleteBlogPost(postId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blogPosts', 'readwrite');
    const req = tx.objectStore('blogPosts').delete(postId);
    req.onsuccess = () => resolve({ deleted: true });
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function deleteBlogPostsByUser(handle) {
  const db = await openDB();

  // First get all post IDs for this user
  const postIds = await new Promise((resolve, reject) => {
    const tx = db.transaction('blogPosts', 'readonly');
    const index = tx.objectStore('blogPosts').index('byUser');
    const req = index.getAllKeys(IDBKeyRange.only(handle));
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  // Delete all posts
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blogPosts', 'readwrite');
    const store = tx.objectStore('blogPosts');
    for (const id of postIds) {
      store.delete(id);
    }
    tx.oncomplete = () => resolve({ deletedPosts: postIds.length });
    tx.onerror = (e) => reject(e.target.error);
  });
}

// --- Delete All Data ---

export async function deleteAllData() {
  const db = await openDB();
  const storeNames = Array.from(db.objectStoreNames);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, 'readwrite');
    for (const name of storeNames) {
      tx.objectStore(name).clear();
    }
    tx.oncomplete = () => resolve({ cleared: storeNames });
    tx.onerror = (e) => reject(e.target.error);
  });
}

// --- Full Database Export/Import ---

export async function exportAllData() {
  const db = await openDB();

  // Get all tweets
  const tweets = await new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const req = tx.objectStore('tweets').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  // Get all users
  const users = await new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readonly');
    const req = tx.objectStore('users').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  // Get all blocked users
  const blockedUsers = await new Promise((resolve, reject) => {
    const tx = db.transaction('blockedUsers', 'readonly');
    const req = tx.objectStore('blockedUsers').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  // Get all settings
  const settings = await new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readonly');
    const req = tx.objectStore('settings').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  // Get all blog posts
  const blogPosts = await new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains('blogPosts')) {
      resolve([]);
      return;
    }
    const tx = db.transaction('blogPosts', 'readonly');
    const req = tx.objectStore('blogPosts').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  // Get all bookmarks
  const bookmarks = await new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains('bookmarks')) {
      resolve([]);
      return;
    }
    const tx = db.transaction('bookmarks', 'readonly');
    const req = tx.objectStore('bookmarks').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  return {
    version: DB_VERSION,
    exportedAt: new Date().toISOString(),
    tweets,
    users,
    blockedUsers,
    settings,
    blogPosts,
    bookmarks
  };
}

export async function importAllData(data, { merge = true } = {}) {
  const db = await openDB();

  // Validate data structure
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid data format');
  }

  const tweets = data.tweets || [];
  const users = data.users || [];
  const blockedUsers = data.blockedUsers || [];
  const settings = data.settings || [];
  const blogPosts = data.blogPosts || [];
  const bookmarks = data.bookmarks || [];

  const stores = ['tweets', 'users', 'blockedUsers', 'settings'];
  if (db.objectStoreNames.contains('blogPosts')) {
    stores.push('blogPosts');
  }
  if (db.objectStoreNames.contains('bookmarks')) {
    stores.push('bookmarks');
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    const tweetStore = tx.objectStore('tweets');
    const userStore = tx.objectStore('users');
    const blockedStore = tx.objectStore('blockedUsers');
    const settingsStore = tx.objectStore('settings');
    const blogStore = db.objectStoreNames.contains('blogPosts') ? tx.objectStore('blogPosts') : null;
    const bookmarkStore = db.objectStoreNames.contains('bookmarks') ? tx.objectStore('bookmarks') : null;

    let importedTweets = 0;
    let importedUsers = 0;
    let importedBlocked = 0;
    let importedSettings = 0;
    let importedBlogPosts = 0;
    let importedBookmarks = 0;

    // Clear existing data if not merging
    if (!merge) {
      tweetStore.clear();
      userStore.clear();
      blockedStore.clear();
      settingsStore.clear();
      if (blogStore) blogStore.clear();
      if (bookmarkStore) bookmarkStore.clear();
    }

    // Import tweets
    for (const tweet of tweets) {
      if (merge) {
        // Only add if doesn't exist
        const getReq = tweetStore.get(tweet.tweetId);
        getReq.onsuccess = () => {
          if (!getReq.result) {
            tweetStore.put(tweet);
            importedTweets++;
          }
        };
      } else {
        tweetStore.put(tweet);
        importedTweets++;
      }
    }

    // Import users
    for (const user of users) {
      if (merge) {
        const getReq = userStore.get(user.handle);
        getReq.onsuccess = () => {
          if (!getReq.result) {
            const importedUser = {
              ...user,
              quickTags: sanitizeUserQuickTags(user.quickTags)
            };
            userStore.put(importedUser);
            importedUsers++;
          } else {
            // Merge: keep higher tweet count, update other fields
            const existing = getReq.result;
            const merged = {
              ...existing,
              displayName: user.displayName || existing.displayName,
              avatarUrl: user.avatarUrl || existing.avatarUrl,
              tweetCount: Math.max(
                normalizeTweetCount(existing.tweetCount),
                normalizeTweetCount(user.tweetCount)
              ),
              starred: existing.starred || user.starred,
              notes: existing.notes || user.notes,
              quickTags: sanitizeUserQuickTags([
                ...(existing.quickTags || []),
                ...(user.quickTags || [])
              ])
            };
            userStore.put(merged);
          }
        };
      } else {
        userStore.put({
          ...user,
          tweetCount: normalizeTweetCount(user.tweetCount),
          quickTags: sanitizeUserQuickTags(user.quickTags)
        });
        importedUsers++;
      }
    }

    // Import blocked users
    for (const blocked of blockedUsers) {
      if (merge) {
        const getReq = blockedStore.get(blocked.handle);
        getReq.onsuccess = () => {
          if (!getReq.result) {
            blockedStore.put(blocked);
            importedBlocked++;
          }
        };
      } else {
        blockedStore.put(blocked);
        importedBlocked++;
      }
    }

    // Import settings
    for (const setting of settings) {
      if (merge) {
        const getReq = settingsStore.get(setting.key);
        getReq.onsuccess = () => {
          if (!getReq.result) {
            settingsStore.put(setting);
            importedSettings++;
          }
        };
      } else {
        settingsStore.put(setting);
        importedSettings++;
      }
    }

    // Import blog posts
    if (blogStore && blogPosts.length > 0) {
      for (const post of blogPosts) {
        if (merge) {
          const getReq = blogStore.get(post.postId);
          getReq.onsuccess = () => {
            if (!getReq.result) {
              blogStore.put(post);
              importedBlogPosts++;
            }
          };
        } else {
          blogStore.put(post);
          importedBlogPosts++;
        }
      }
    }

    // Import bookmarks
    if (bookmarkStore && bookmarks.length > 0) {
      for (const bookmark of bookmarks) {
        if (merge) {
          const getReq = bookmarkStore.get(bookmark.tweetId);
          getReq.onsuccess = () => {
            if (!getReq.result) {
              bookmarkStore.put(bookmark);
              importedBookmarks++;
            }
          };
        } else {
          bookmarkStore.put(bookmark);
          importedBookmarks++;
        }
      }
    }

    tx.oncomplete = () => resolve({
      tweets: merge ? importedTweets : tweets.length,
      users: merge ? importedUsers : users.length,
      blockedUsers: merge ? importedBlocked : blockedUsers.length,
      settings: merge ? importedSettings : settings.length,
      blogPosts: merge ? importedBlogPosts : blogPosts.length,
      bookmarks: merge ? importedBookmarks : bookmarks.length
    });
    tx.onerror = (e) => reject(e.target.error);
  });
}
