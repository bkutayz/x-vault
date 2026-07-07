import {
  storeTweet,
  storeUser,
  adjustUserTweetCount,
  getAllUsers,
  getUser,
  getTweetsByUser,
  searchTweets,
  getTweetCount,
  getTweetCountByUser,
  getAllTweetsForUser,
  deleteUserAndTweets,
  deleteTweet,
  deleteAllData,
  blockUser,
  unblockUser,
  getBlockedUsers,
  isBlocked,
  getCaptureFromHome,
  setCaptureFromHome,
  getHomeFeedSettings,
  setHomeFeedSettings,
  setUserStarred,
  updateUserNotes,
  addQuickTagToUser,
  removeQuickTagFromUser,
  getQuickTagsForUser,
  getAllQuickUserTags,
  exportAllData,
  importAllData,
  getRecentTweets,
  getAISettings,
  setAISettings,
  storeBlogPost,
  getBlogPostsByUser,
  getBlogPost,
  updateBlogPost,
  deleteBlogPost,
  getAutoBackupSettings,
  setAutoBackupSettings,
  addTagToTweet,
  removeTagFromTweet,
  getTagsForTweet,
  getTweetsByTag,
  getAllTags,
  getCaptureStats,
  storeBookmark,
  getAllBookmarks,
  getBookmarkCount,
  deleteBookmark,
  clearBookmarks
} from './db.js';

console.log('[X-Vault] Background service worker loaded at', new Date().toISOString());

// Open dashboard when extension icon is clicked
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

// ==================== Auto-Backup via chrome.alarms ====================

async function setupAutoBackupAlarm() {
  const settings = await getAutoBackupSettings();
  if (settings.enabled) {
    chrome.alarms.create('auto-backup', { periodInMinutes: settings.intervalHours * 60 });
    console.log(`[X-Vault] Auto-backup alarm set: every ${settings.intervalHours}h`);
  } else {
    chrome.alarms.clear('auto-backup');
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'auto-backup') {
    console.log('[X-Vault] Auto-backup triggered');
    try {
      const data = await exportAllData();
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const date = new Date().toISOString().split('T')[0];
      chrome.downloads.download({
        url,
        filename: `x-vault-backup-${date}.json`,
        saveAs: false
      }, () => {
        URL.revokeObjectURL(url);
      });

      await setAutoBackupSettings({
        ...(await getAutoBackupSettings()),
        lastBackupAt: new Date().toISOString()
      });
      console.log('[X-Vault] Auto-backup completed');
    } catch (err) {
      console.error('[X-Vault] Auto-backup failed:', err);
    }
  }
});

// Initialize alarm on service worker start
setupAutoBackupAlarm();

// ==================== Message Handler ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((err) => {
    console.error('[X-Vault] Error handling message:', message.type, err);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case 'STORE_TWEET': {
      // Check if user is blocked before storing
      if (await isBlocked(message.tweet.handle)) {
        return { inserted: false, blocked: true };
      }

      const result = await storeTweet(message.tweet);
      if (result.inserted) {
        // Store user metadata (skipCount=true) then increment count O(1)
        await storeUser({
          handle: message.tweet.handle,
          displayName: message.tweet.displayName,
          avatarUrl: message.tweet.avatarUrl,
          lastSeen: new Date().toISOString()
        }, { skipCount: true });
        const user = await adjustUserTweetCount(message.tweet.handle, 1);
        const count = await getTweetCount();
        chrome.action.setBadgeText({ text: String(count) });
        chrome.action.setBadgeBackgroundColor({ color: '#1DA1F2' });

        chrome.runtime.sendMessage({
          type: 'TWEET_ADDED',
          tweet: message.tweet,
          totalCount: count,
          user
        }).catch(() => { });
      }
      return result;
    }

    case 'GET_USERS':
      return await getAllUsers();

    case 'GET_USER':
      return await getUser(message.handle);

    case 'GET_TWEETS_BY_USER':
      return await getTweetsByUser(message.handle, {
        limit: message.limit || 50,
        offset: message.offset || 0
      });

    case 'SEARCH_TWEETS':
      return await searchTweets(message.query, {
        limit: message.limit || 100
      });

    case 'GET_TWEET_COUNT':
      return await getTweetCount();

    case 'GET_USER_TWEET_COUNT':
      return await getTweetCountByUser(message.handle);

    case 'GET_RECENT_TWEETS':
      return await getRecentTweets({ limit: message.limit || 50 });

    case 'GET_ALL_TWEETS_FOR_USER':
      return await getAllTweetsForUser(message.handle);

    case 'DELETE_USER': {
      console.log('[X-Vault] DELETE_USER called for:', message.handle);
      try {
        await deleteUserAndTweets(message.handle);
        const count = await getTweetCount();
        chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
        console.log('[X-Vault] DELETE_USER success, remaining tweets:', count);
        return { deleted: true, totalCount: count };
      } catch (err) {
        console.error('[X-Vault] DELETE_USER failed:', err);
        return { error: err.message, deleted: false };
      }
    }

    case 'DELETE_TWEET': {
      await deleteTweet(message.tweetId);
      // Decrement the user's tweet count O(1)
      if (message.handle) {
        await adjustUserTweetCount(message.handle, -1);
      }
      const count = await getTweetCount();
      chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
      return { deleted: true, totalCount: count };
    }

    case 'BLOCK_USER': {
      await blockUser(message.handle);
      // Also delete existing data for this user
      await deleteUserAndTweets(message.handle);
      const count = await getTweetCount();
      chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
      return { blocked: true, totalCount: count };
    }

    case 'UNBLOCK_USER':
      await unblockUser(message.handle);
      return { unblocked: true };

    case 'GET_BLOCKED_USERS':
      return await getBlockedUsers();

    case 'STAR_USER':
      await setUserStarred(message.handle, true);
      return { starred: true };

    case 'UNSTAR_USER':
      await setUserStarred(message.handle, false);
      return { unstarred: true };

    case 'UPDATE_USER_NOTES':
      return await updateUserNotes(message.handle, message.notes);

    case 'ADD_USER_QUICK_TAG':
      return await addQuickTagToUser(message.handle, message.tag);

    case 'REMOVE_USER_QUICK_TAG':
      return await removeQuickTagFromUser(message.handle, message.tag);

    case 'GET_USER_QUICK_TAGS':
      return await getQuickTagsForUser(message.handle);

    case 'GET_ALL_USER_QUICK_TAGS':
      return await getAllQuickUserTags();

    // Blog Posts
    case 'STORE_BLOG_POST':
      return await storeBlogPost(message.post);

    case 'GET_BLOG_POSTS_BY_USER':
      return await getBlogPostsByUser(message.handle);

    case 'GET_BLOG_POST':
      return await getBlogPost(message.postId);

    case 'UPDATE_BLOG_POST':
      return await updateBlogPost(message.postId, message.updates);

    case 'DELETE_BLOG_POST':
      return await deleteBlogPost(message.postId);

    // Tags / Collections
    case 'TAG_TWEET':
      return await addTagToTweet(message.tweetId, message.tag);

    case 'UNTAG_TWEET':
      return await removeTagFromTweet(message.tweetId, message.tag);

    case 'GET_TWEET_TAGS':
      return await getTagsForTweet(message.tweetId);

    case 'GET_TWEETS_BY_TAG':
      return await getTweetsByTag(message.tag);

    case 'GET_ALL_TAGS':
      return await getAllTags();

    // Auto-Backup
    case 'GET_AUTO_BACKUP_SETTINGS':
      return await getAutoBackupSettings();

    case 'SET_AUTO_BACKUP_SETTINGS':
      await setAutoBackupSettings(message.settings);
      await setupAutoBackupAlarm();
      return { success: true };

    // Bookmarks
    case 'STORE_BOOKMARK': {
      const result = await storeBookmark(message.tweet);
      if (result.inserted) {
        const count = await getBookmarkCount();
        // Notify any open dashboard so its count stays live
        chrome.runtime.sendMessage({ type: 'BOOKMARK_ADDED', count }).catch(() => { });
      }
      return result;
    }

    case 'GET_BOOKMARKS':
      return await getAllBookmarks();

    case 'GET_BOOKMARK_COUNT':
      return await getBookmarkCount();

    case 'DELETE_BOOKMARK':
      return await deleteBookmark(message.tweetId);

    case 'CLEAR_BOOKMARKS':
      return await clearBookmarks();

    case 'SYNC_BOOKMARKS': {
      // Open the X bookmarks page with a marker so the content script
      // auto-starts the "grab all" scroll capture on load.
      chrome.tabs.create({ url: 'https://x.com/i/bookmarks#xvault-grab' });
      return { opened: true };
    }

    // Analytics
    case 'GET_CAPTURE_STATS':
      return await getCaptureStats();

    case 'DELETE_ALL_DATA': {
      await deleteAllData();
      chrome.action.setBadgeText({ text: '' });
      return { deleted: true };
    }

    case 'OPEN_POPUP': {
      // Open the dashboard in a new tab
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
      return { opened: true };
    }

    case 'GET_CAPTURE_FROM_HOME':
      return await getCaptureFromHome();

    case 'SET_CAPTURE_FROM_HOME':
      await setCaptureFromHome(message.enabled);
      return { success: true };

    case 'GET_HOME_FEED_SETTINGS':
      return await getHomeFeedSettings();

    case 'SET_HOME_FEED_SETTINGS':
      await setHomeFeedSettings(message.settings);
      return { success: true };

    case 'GET_AI_SETTINGS':
      return await getAISettings();

    case 'SET_AI_SETTINGS':
      await setAISettings(message.settings);
      return { success: true };

    case 'EXPORT_DATABASE':
      return await exportAllData();

    case 'IMPORT_DATABASE': {
      const result = await importAllData(message.data, { merge: message.merge !== false });
      const count = await getTweetCount();
      chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
      return { success: true, imported: result, totalCount: count };
    }

    default:
      console.error('[X-Vault] Unknown message type received:', message.type, message);
      return { error: 'Unknown message type' };
  }
}
