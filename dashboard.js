let currentTweets = [];
let selectedUser = null;
let selectedUserData = null;
let allSelectMode = false;
let notesDebounce = null;
let currentView = 'home';
let currentSort = 'date';
let editingPostId = null; // Track if editing existing post

// Pagination constants
const TWEET_BATCH_SIZE = 30;
const USER_BATCH_SIZE = 50;
let tweetRenderIndex = 0;
let tweetObserver = null;
let recentRenderIndex = 0;
let recentObserver = null;
let userRenderIndex = 0;
let userObserver = null;
let allUsersCache = [];
let homeAISelectedTweet = null;

let toastTimer = null;

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, resolve);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTimestamp(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
  });
}

function formatMetricCount(n) {
  if (!n || n === 0) return '';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function formatDate(iso) {
  if (!iso) return '?';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function normalizeTweetCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

// ==================== Toast with Undo ====================

function showToast(msg) {
  clearTimeout(toastTimer);
  const toast = document.getElementById('toast');
  const msgEl = document.getElementById('toast-msg');
  msgEl.textContent = msg;
  toast.classList.remove('hidden');
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2000);
}

// ==================== User Sidebar ====================

function renderUserList(users) {
  const container = document.getElementById('user-list');
  container.innerHTML = '';
  allUsersCache = users;
  userRenderIndex = 0;

  if (userObserver) userObserver.disconnect();

  renderNextUserBatch(container);
}

function renderNextUserBatch(container) {
  const end = Math.min(userRenderIndex + USER_BATCH_SIZE, allUsersCache.length);
  for (let i = userRenderIndex; i < end; i++) {
    container.appendChild(createUserItem(allUsersCache[i]));
  }
  userRenderIndex = end;

  // Remove old sentinel
  const oldSentinel = container.querySelector('.user-sentinel');
  if (oldSentinel) oldSentinel.remove();

  // Add sentinel if more users remain
  if (userRenderIndex < allUsersCache.length) {
    const sentinel = document.createElement('div');
    sentinel.className = 'user-sentinel';
    sentinel.style.height = '1px';
    container.appendChild(sentinel);

    userObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        userObserver.disconnect();
        renderNextUserBatch(container);
      }
    }, { root: container });
    userObserver.observe(sentinel);
  }
}

function createUserItem(user) {
  const el = document.createElement('div');
  el.className = 'user-item';
  el.dataset.handle = user.handle;
  if (selectedUser === user.handle) el.classList.add('active');

  // Avatar
  const avatar = document.createElement('div');
  avatar.className = 'user-avatar';
  if (user.avatarUrl) {
    const img = document.createElement('img');
    img.src = user.avatarUrl;
    img.alt = `@${user.handle}`;
    avatar.appendChild(img);
  } else {
    // Default avatar placeholder
    avatar.innerHTML = `<span class="avatar-placeholder">${user.handle.charAt(0).toUpperCase()}</span>`;
  }
  el.appendChild(avatar);

  if (user.starred) {
    const star = document.createElement('span');
    star.className = 'user-star';
    star.textContent = '\u2605';
    el.appendChild(star);
  }

  const name = document.createElement('span');
  name.className = 'user-handle';
  name.textContent = `@${user.handle}`;
  el.appendChild(name);

  const badge = document.createElement('span');
  badge.className = 'count-badge';
  badge.textContent = normalizeTweetCount(user.tweetCount);
  el.appendChild(badge);

  // Hover actions
  const actions = document.createElement('div');
  actions.className = 'user-actions';

  const delBtn = document.createElement('button');
  delBtn.title = 'Delete user and tweets';
  delBtn.textContent = '\u00d7';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteUser(user.handle);
  });
  actions.appendChild(delBtn);

  el.appendChild(actions);

  el.addEventListener('click', () => selectUser(user.handle));
  return el;
}

function refreshUserList(updatedUser) {
  const container = document.getElementById('user-list');
  const existing = container.querySelector(`[data-handle="${updatedUser.handle}"]`);

  if (existing) {
    existing.querySelector('.count-badge').textContent = normalizeTweetCount(updatedUser.tweetCount);
  } else {
    container.appendChild(createUserItem(updatedUser));
  }
}

// ==================== User Context Card ====================

function renderUserQuickTags(tags) {
  const list = document.getElementById('user-quick-tags-list');
  list.innerHTML = '';

  if (!tags || tags.length === 0) {
    list.innerHTML = '<span class="quick-tags-empty">No quick tags yet.</span>';
    return;
  }

  for (const tag of tags) {
    const chip = document.createElement('span');
    chip.className = 'quick-tag-chip';
    chip.innerHTML = `#${escapeHtml(tag)} <button type="button" title="Remove tag" data-tag="${escapeHtml(tag)}">&times;</button>`;

    chip.querySelector('button').addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeQuickTagFromSelectedUser(tag);
    });

    list.appendChild(chip);
  }
}

function renderUserQuickTagSuggestions(allTags, currentTags) {
  const container = document.getElementById('user-quick-tags-suggestions');
  container.innerHTML = '';

  const currentSet = new Set(currentTags || []);
  const suggestions = (allTags || [])
    .filter(item => item.tag && !currentSet.has(item.tag))
    .slice(0, 8);

  if (suggestions.length === 0) {
    container.innerHTML = '<span class="quick-tags-suggestions-empty">No suggestions yet.</span>';
    return;
  }

  for (const item of suggestions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-tag-suggestion';
    btn.textContent = `+ ${item.tag}`;
    btn.title = `Used by ${item.count} user${item.count === 1 ? '' : 's'}`;
    btn.addEventListener('click', async () => {
      const input = document.getElementById('user-quick-tag-input');
      if (input) input.value = item.tag;
      await addQuickTagFromInput();
    });
    container.appendChild(btn);
  }
}

async function refreshUserQuickTags(handle = selectedUser) {
  if (!handle) return;

  const [tags, allTags] = await Promise.all([
    sendMessage({ type: 'GET_USER_QUICK_TAGS', handle }),
    sendMessage({ type: 'GET_ALL_USER_QUICK_TAGS' })
  ]);

  if (selectedUser !== handle) return;

  const userTags = Array.isArray(tags) ? tags : [];
  renderUserQuickTags(userTags);
  renderUserQuickTagSuggestions(Array.isArray(allTags) ? allTags : [], userTags);
}

async function addQuickTagFromInput() {
  if (!selectedUser) return;

  const input = document.getElementById('user-quick-tag-input');
  const rawTag = input.value.trim();
  if (!rawTag) return;

  const handle = selectedUser;
  const result = await sendMessage({ type: 'ADD_USER_QUICK_TAG', handle, tag: rawTag });
  if (selectedUser !== handle) return;

  if (result?.error || result?.invalid || result?.userMissing) {
    showToast('Failed to add quick tag');
    return;
  }

  if (result?.exists) {
    showToast(`Tag already exists: ${result.tag}`);
  } else {
    showToast(`Added tag: ${result.tag}`);
  }

  input.value = '';
  await refreshUserQuickTags(handle);
}

async function removeQuickTagFromSelectedUser(tag) {
  if (!selectedUser) return;

  const handle = selectedUser;
  const result = await sendMessage({ type: 'REMOVE_USER_QUICK_TAG', handle, tag });
  if (selectedUser !== handle) return;

  if (result?.removed) {
    showToast(`Removed tag: ${tag}`);
    await refreshUserQuickTags(handle);
  }
}

async function showUserContext(handle) {
  const user = await sendMessage({ type: 'GET_USER', handle });
  if (!user || selectedUser !== handle) return;
  selectedUserData = user;

  document.getElementById('user-context').classList.remove('hidden');
  document.getElementById('llm-bar').classList.remove('hidden');
  document.getElementById('sort-bar').classList.remove('hidden');

  document.getElementById('ctx-name').textContent = user.displayName || handle;
  document.getElementById('ctx-handle').textContent = `@${handle}`;
  document.getElementById('ctx-tweet-count').textContent = `${normalizeTweetCount(user.tweetCount)} tweets captured`;

  // Date range from current tweets
  if (currentTweets.length > 0) {
    const dates = currentTweets.map(t => t.timestamp).filter(Boolean).sort();
    const oldest = dates[0];
    const newest = dates[dates.length - 1];
    document.getElementById('ctx-date-range').textContent = `${formatDate(oldest)} \u2014 ${formatDate(newest)}`;
  } else {
    document.getElementById('ctx-date-range').textContent = '';
  }

  // Star button
  const starBtn = document.getElementById('ctx-star');
  starBtn.innerHTML = user.starred ? '&#9733; Starred' : '&#9734; Star';
  starBtn.className = user.starred ? 'ctx-btn starred' : 'ctx-btn';

  // Notes
  document.getElementById('user-notes').value = user.notes || '';
  document.getElementById('user-quick-tag-input').value = '';

  await refreshUserQuickTags(handle);
  if (selectedUser !== handle) return;

  // Blog posts
  await loadBlogPosts(handle);
}

function hideUserContext() {
  document.getElementById('user-context').classList.add('hidden');
  document.getElementById('llm-bar').classList.add('hidden');
  document.getElementById('sort-bar').classList.add('hidden');
  document.getElementById('user-quick-tags-list').innerHTML = '';
  document.getElementById('user-quick-tags-suggestions').innerHTML = '';
  document.getElementById('user-quick-tag-input').value = '';
  selectedUserData = null;
}

// Star button
document.getElementById('ctx-star').addEventListener('click', async () => {
  if (!selectedUser || !selectedUserData) return;
  const isStarred = selectedUserData.starred;
  await sendMessage({ type: isStarred ? 'UNSTAR_USER' : 'STAR_USER', handle: selectedUser });
  selectedUserData.starred = !isStarred;

  const starBtn = document.getElementById('ctx-star');
  starBtn.innerHTML = selectedUserData.starred ? '&#9733; Starred' : '&#9734; Star';
  starBtn.className = selectedUserData.starred ? 'ctx-btn starred' : 'ctx-btn';

  // Refresh sidebar
  const users = await sendMessage({ type: 'GET_USERS' });
  if (users) renderUserList(users);
});

// Block button
document.getElementById('ctx-block').addEventListener('click', () => {
  if (!selectedUser) return;
  blockUserNow(selectedUser);
});

// Delete button
document.getElementById('ctx-delete').addEventListener('click', () => {
  if (!selectedUser) return;
  deleteUser(selectedUser);
});

// Notes auto-save
document.getElementById('user-notes').addEventListener('input', (e) => {
  clearTimeout(notesDebounce);
  notesDebounce = setTimeout(async () => {
    if (!selectedUser) return;
    await sendMessage({ type: 'UPDATE_USER_NOTES', handle: selectedUser, notes: e.target.value });
  }, 500);
});

document.getElementById('user-quick-tag-add').addEventListener('click', async () => {
  await addQuickTagFromInput();
});

document.getElementById('user-quick-tag-input').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  await addQuickTagFromInput();
});

// ==================== Blog Posts ====================

async function loadBlogPosts(handle) {
  const posts = await sendMessage({ type: 'GET_BLOG_POSTS_BY_USER', handle });
  if (selectedUser !== handle) return;
  renderBlogPostsList(posts || []);
}

function renderBlogPostsList(posts) {
  const container = document.getElementById('blog-posts-list');
  container.innerHTML = '';

  if (posts.length === 0) {
    container.innerHTML = '<div class="blog-posts-empty">No blog posts yet.</div>';
    return;
  }

  for (const post of posts) {
    const item = document.createElement('div');
    item.className = 'blog-post-item';
    item.dataset.postId = post.postId;

    const title = post.title || 'Untitled Post';
    const preview = post.content ? post.content.substring(0, 80) + (post.content.length > 80 ? '...' : '') : '';
    const date = new Date(post.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    item.innerHTML = `
      <div class="blog-post-item-content">
        <span class="blog-post-item-title">${escapeHtml(title)}</span>
        <span class="blog-post-item-preview">${escapeHtml(preview)}</span>
        <span class="blog-post-item-date">${date}</span>
      </div>
      <button class="blog-post-item-edit" title="Edit post">Edit</button>
    `;

    item.querySelector('.blog-post-item-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      openBlogPostModal(post);
    });

    item.addEventListener('click', () => openBlogPostModal(post));
    container.appendChild(item);
  }
}

function openBlogPostModal(post = null) {
  editingPostId = post ? post.postId : null;

  const titleEl = document.getElementById('blog-post-modal-title');
  const titleInput = document.getElementById('blog-post-title-input');
  const contentInput = document.getElementById('blog-post-content-input');
  const deleteBtn = document.getElementById('blog-post-delete-btn');

  if (post) {
    titleEl.textContent = 'Edit Blog Post';
    titleInput.value = post.title || '';
    contentInput.value = post.content || '';
    deleteBtn.classList.remove('hidden');
  } else {
    titleEl.textContent = 'New Blog Post';
    titleInput.value = '';
    contentInput.value = '';
    deleteBtn.classList.add('hidden');
  }

  document.getElementById('blog-post-modal-overlay').classList.remove('hidden');
  titleInput.focus();
}

function closeBlogPostModal() {
  document.getElementById('blog-post-modal-overlay').classList.add('hidden');
  editingPostId = null;
}

// Add new post button
document.getElementById('add-blog-post-btn').addEventListener('click', () => {
  if (!selectedUser) return;
  openBlogPostModal();
});

// Close modal
document.getElementById('blog-post-modal-close').addEventListener('click', closeBlogPostModal);
document.getElementById('blog-post-modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeBlogPostModal();
});

// Save blog post
document.getElementById('blog-post-save-btn').addEventListener('click', async () => {
  if (!selectedUser) return;

  const title = document.getElementById('blog-post-title-input').value.trim();
  const content = document.getElementById('blog-post-content-input').value.trim();

  if (!content && !title) {
    showToast('Please enter some content');
    return;
  }

  if (editingPostId) {
    // Update existing post
    await sendMessage({
      type: 'UPDATE_BLOG_POST',
      postId: editingPostId,
      updates: { title, content }
    });
    showToast('Post updated');
  } else {
    // Create new post
    await sendMessage({
      type: 'STORE_BLOG_POST',
      post: { handle: selectedUser, title, content }
    });
    showToast('Post created');
  }

  closeBlogPostModal();
  await loadBlogPosts(selectedUser);
});

// Delete blog post
document.getElementById('blog-post-delete-btn').addEventListener('click', async () => {
  if (!editingPostId) return;

  await sendMessage({ type: 'DELETE_BLOG_POST', postId: editingPostId });
  showToast('Post deleted');
  closeBlogPostModal();
  await loadBlogPosts(selectedUser);
});

// ==================== Delete / Block (immediate) ====================

async function deleteUser(handle) {
  try {
    const result = await sendMessage({ type: 'DELETE_USER', handle });
    // Check if delete succeeded - prioritize deleted:true over any error
    if (!result || (result.error && !result.deleted)) {
      console.error('[Dashboard] Delete user error:', result?.error || 'No response');
      showToast(`Error deleting @${handle}`);
      return false;
    }
    showToast(`Deleted @${handle}`);

    const userEl = document.querySelector(`#user-list [data-handle="${handle}"]`);
    if (userEl) userEl.remove();

    await refreshCounts();

    if (selectedUser === handle) {
      const users = await sendMessage({ type: 'GET_USERS' });
      if (users && users.length > 0) {
        renderUserList(users);
        selectUser(users[0].handle);
      } else {
        hideUserContext();
        renderUserList([]);
        renderTweetList([]);
      }
    }
    return true;
  } catch (err) {
    console.error('[Dashboard] Delete user exception:', err);
    showToast(`Error deleting @${handle}`);
    return false;
  }
}

async function blockUserNow(handle) {
  await sendMessage({ type: 'BLOCK_USER', handle });
  showToast(`Blocked @${handle}`);

  const userEl = document.querySelector(`#user-list [data-handle="${handle}"]`);
  if (userEl) userEl.remove();

  await refreshCounts();

  if (selectedUser === handle) {
    const users = await sendMessage({ type: 'GET_USERS' });
    if (users && users.length > 0) {
      renderUserList(users);
      selectUser(users[0].handle);
    } else {
      hideUserContext();
      renderUserList([]);
      renderTweetList([]);
    }
  }
}

async function deleteTweetNow(tweet, card) {
  await sendMessage({ type: 'DELETE_TWEET', tweetId: tweet.tweetId, handle: tweet.handle });
  currentTweets = currentTweets.filter(t => t.tweetId !== tweet.tweetId);
  card.remove();
  showToast('Tweet deleted');

  await refreshCounts();
  if (selectedUser) {
    const user = await sendMessage({ type: 'GET_USER', handle: selectedUser });
    if (user) {
      const badge = document.querySelector(`[data-handle="${selectedUser}"] .count-badge`);
      if (badge) badge.textContent = normalizeTweetCount(user.tweetCount);
      const ctxCount = document.getElementById('ctx-tweet-count');
      if (ctxCount) ctxCount.textContent = `${normalizeTweetCount(user.tweetCount)} tweets captured`;
    }
  }
}

async function refreshCounts() {
  const count = await sendMessage({ type: 'GET_TWEET_COUNT' });
  document.getElementById('tweet-count').textContent = `${count || 0} tweets`;
}

// ==================== Tweet List ====================

function renderTweetList(tweets) {
  currentTweets = tweets;
  allSelectMode = false;
  document.getElementById('select-all').textContent = 'Select All';
  const container = document.getElementById('tweet-list');
  container.innerHTML = '';
  tweetRenderIndex = 0;

  if (tweetObserver) tweetObserver.disconnect();

  if (tweets.length === 0) {
    container.innerHTML = '<div id="empty-state">No tweets found.</div>';
    return;
  }

  renderNextTweetBatch(container, currentTweets, true);
}

function renderNextTweetBatch(container, tweets, selectable) {
  const end = Math.min(tweetRenderIndex + TWEET_BATCH_SIZE, tweets.length);
  for (let i = tweetRenderIndex; i < end; i++) {
    container.appendChild(selectable ? createTweetCard(tweets[i]) : createGridCard(tweets[i]));
  }
  tweetRenderIndex = end;

  // Remove old sentinel
  const oldSentinel = container.querySelector('.tweet-sentinel');
  if (oldSentinel) oldSentinel.remove();

  // Add sentinel if more tweets remain
  if (tweetRenderIndex < tweets.length) {
    const sentinel = document.createElement('div');
    sentinel.className = 'tweet-sentinel';
    sentinel.style.height = '1px';
    container.appendChild(sentinel);

    tweetObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        tweetObserver.disconnect();
        renderNextTweetBatch(container, tweets, selectable);
      }
    }, { root: container });
    tweetObserver.observe(sentinel);
  }
}

function appendTweet(tweet) {
  if (currentTweets.some(t => t.tweetId === tweet.tweetId)) return;

  currentTweets.unshift(tweet);

  const container = document.getElementById('tweet-list');
  const empty = container.querySelector('#empty-state');
  if (empty) empty.remove();

  container.prepend(createTweetCard(tweet));
}

// ==================== Sort ====================

function sortTweets(tweets, sortBy) {
  switch (sortBy) {
    case 'likes':
      return [...tweets].sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
    case 'views':
      return [...tweets].sort((a, b) => (b.viewCount || b.impressionCount || 0) - (a.viewCount || a.impressionCount || 0));
    case 'date':
    default:
      return [...tweets].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }
}

function applySortAndRender() {
  const sorted = sortTweets(currentTweets, currentSort);
  currentTweets = sorted;
  const container = document.getElementById('tweet-list');
  container.innerHTML = '';
  tweetRenderIndex = 0;

  if (tweetObserver) tweetObserver.disconnect();

  if (sorted.length === 0) {
    container.innerHTML = '<div id="empty-state">No tweets found.</div>';
    return;
  }
  renderNextTweetBatch(container, sorted, true);
}

document.querySelectorAll('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentSort = btn.dataset.sort;
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b === btn));
    applySortAndRender();
  });
});

async function selectUser(handle) {
  selectedUser = handle;

  // Reset sort to date
  currentSort = 'date';
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === 'date'));

  document.querySelectorAll('.user-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.handle === handle);
  });

  const tweets = await sendMessage({
    type: 'GET_TWEETS_BY_USER',
    handle,
    limit: 500
  });
  renderTweetList(tweets || []);
  showUserContext(handle);
}

// ==================== Selection ====================

function getSelectedTweetIds() {
  return Array.from(document.querySelectorAll('.tweet-checkbox:checked')).map(cb => cb.value);
}

document.getElementById('select-all').addEventListener('click', () => {
  allSelectMode = !allSelectMode;
  document.querySelectorAll('.tweet-checkbox').forEach((cb) => {
    cb.checked = allSelectMode;
    cb.closest('.tweet-card').classList.toggle('selected', allSelectMode);
  });
  document.getElementById('select-all').textContent = allSelectMode ? 'Deselect All' : 'Select All';
});

// ==================== Export ====================

function formatTweets(tweets, format) {
  switch (format) {
    case 'markdown':
      return tweets.map(t =>
        `### @${t.handle} - ${t.displayName}\n` +
        `**${new Date(t.timestamp).toLocaleString()}** | [Link](${t.url})\n\n` +
        `${t.fullText}\n\n---`
      ).join('\n\n');

    case 'json':
      return JSON.stringify(tweets.map(t => ({
        handle: t.handle,
        displayName: t.displayName,
        timestamp: t.timestamp,
        text: t.fullText,
        url: t.url
      })), null, 2);

    case 'text':
      return tweets.map(t =>
        `@${t.handle} (${new Date(t.timestamp).toLocaleString()}):\n` +
        `${t.fullText}\n${t.url}\n---`
      ).join('\n\n');

    default:
      return '';
  }
}

document.getElementById('export-selected').addEventListener('click', async () => {
  const ids = getSelectedTweetIds();
  if (ids.length === 0) {
    showToast('No tweets selected');
    return;
  }
  const tweets = currentTweets.filter(t => ids.includes(t.tweetId));
  const format = document.getElementById('export-format').value;
  await navigator.clipboard.writeText(formatTweets(tweets, format));
  showToast(`Copied ${tweets.length} tweet${tweets.length !== 1 ? 's' : ''}`);
});

document.getElementById('copy-all').addEventListener('click', async () => {
  if (currentTweets.length === 0) {
    showToast('No tweets to copy');
    return;
  }
  const format = document.getElementById('export-format').value;
  await navigator.clipboard.writeText(formatTweets(currentTweets, format));
  showToast(`Copied ${currentTweets.length} tweet${currentTweets.length !== 1 ? 's' : ''}`);
});

// ==================== LLM Prompt Templates ====================

function formatTweetsForLLM(tweets) {
  return tweets
    .map(t => t.fullText)
    .filter(Boolean)
    .join('\n---\n');
}

const LLM_PROMPTS = {
  summarize: (handle, name) =>
    `Below are tweets from @${handle} (${name}). Provide a comprehensive summary of this person's thinking, worldview, and main ideas. What are the key themes? What positions do they take?\n\n`,
  beliefs: (handle, name) =>
    `Below are tweets from @${handle} (${name}). Extract this person's core beliefs, values, and convictions. What do they strongly believe in? What principles guide their thinking?\n\n`,
  topics: (handle, name) =>
    `Below are tweets from @${handle} (${name}). Identify and rank the top topics this person tweets about. For each topic, summarize their stance.\n\n`,
  style: (handle, name) =>
    `Below are tweets from @${handle} (${name}). Analyze their writing style, tone, and rhetorical techniques. How would you characterize their voice?\n\n`,
  predict: (handle, name) =>
    `Below are tweets from @${handle} (${name}). Based on their thinking patterns and beliefs, predict how they would respond to a topic of my choosing. First, summarize their thinking framework.\n\n`
};

document.querySelectorAll('.llm-prompt').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const promptType = btn.dataset.prompt;

    if (promptType === 'custom') {
      document.getElementById('prompt-modal-overlay').classList.remove('hidden');
      document.getElementById('custom-prompt-input').focus();
      return;
    }

    if (currentTweets.length === 0) {
      showToast('No tweets to send');
      return;
    }

    const handle = selectedUser || currentTweets[0].handle;
    const name = selectedUserData?.displayName || handle;
    const prompt = LLM_PROMPTS[promptType](handle, name);
    const tweetsText = formatTweetsForLLM(currentTweets);
    const fullPrompt = prompt + tweetsText;

    await navigator.clipboard.writeText(fullPrompt);
    showToast(`Copied prompt + ${currentTweets.length} tweets`);
  });
});

// Custom prompt modal
document.getElementById('prompt-modal-close').addEventListener('click', () => {
  document.getElementById('prompt-modal-overlay').classList.add('hidden');
});

document.getElementById('prompt-modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

document.getElementById('custom-prompt-copy').addEventListener('click', async () => {
  const customPrompt = document.getElementById('custom-prompt-input').value.trim();
  if (!customPrompt) {
    showToast('Enter a prompt first');
    return;
  }
  if (currentTweets.length === 0) {
    showToast('No tweets to send');
    return;
  }

  const handle = selectedUser || currentTweets[0].handle;
  const name = selectedUserData?.displayName || handle;
  const intro = `Below are tweets from @${handle} (${name}). ${customPrompt}\n\n`;
  const tweetsText = formatTweetsForLLM(currentTweets);
  const fullPrompt = intro + tweetsText;

  await navigator.clipboard.writeText(fullPrompt);
  document.getElementById('prompt-modal-overlay').classList.add('hidden');
  showToast(`Copied prompt + ${currentTweets.length} tweets`);
});

// ==================== Cleanup: Remove Low-Count Users ====================

document.getElementById('cleanup-btn').addEventListener('click', async () => {
  const threshold = parseInt(document.getElementById('cleanup-threshold').value, 10);
  if (isNaN(threshold) || threshold < 1) {
    showToast('Invalid threshold value');
    return;
  }

  const users = await sendMessage({ type: 'GET_USERS' });
  if (!users || !Array.isArray(users)) {
    showToast('Failed to get users');
    return;
  }

  const usersWithCounts = await Promise.all(users.map(async (user) => {
    const actualCount = await sendMessage({ type: 'GET_USER_TWEET_COUNT', handle: user.handle });
    return {
      ...user,
      actualTweetCount: Number.isFinite(actualCount)
        ? actualCount
        : normalizeTweetCount(user.tweetCount)
    };
  }));

  const toRemove = usersWithCounts.filter(user => user.actualTweetCount <= threshold);

  console.log(
    '[Dashboard] Cleanup: threshold =',
    threshold,
    ', users to remove =',
    toRemove.length,
    toRemove.map(u => `@${u.handle}(${u.actualTweetCount})`)
  );

  if (toRemove.length === 0) {
    showToast('No users to remove');
    return;
  }

  // Delete users one by one to avoid overloading the background worker.
  let deletedCount = 0;
  for (const user of toRemove) {
    try {
      const result = await sendMessage({ type: 'DELETE_USER', handle: user.handle });
      if (result && !result.error) {
        deletedCount++;
      }
    } catch (err) {
      console.error('[Dashboard] Failed to delete user:', user.handle, err);
    }
  }

  showToast(`Removed ${deletedCount} user${deletedCount !== 1 ? 's' : ''}`);

  await refreshCounts();
  const remaining = await sendMessage({ type: 'GET_USERS' });
  if (remaining && remaining.length > 0) {
    renderUserList(remaining);
    selectUser(remaining[0].handle);
  } else {
    hideUserContext();
    renderUserList([]);
    renderTweetList([]);
  }
});

// ==================== Export / Import Database ====================

document.getElementById('export-db-btn').addEventListener('click', async () => {
  try {
    const data = await sendMessage({ type: 'EXPORT_DATABASE' });
    if (!data || data.error) {
      showToast('Export failed');
      return;
    }

    // Create downloadable JSON file
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `x-vault-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(`Exported ${data.tweets.length} tweets, ${data.users.length} users`);
  } catch (err) {
    console.error('[Dashboard] Export failed:', err);
    showToast('Export failed');
  }
});

document.getElementById('import-db-btn').addEventListener('click', () => {
  document.getElementById('import-file-input').click();
});

document.getElementById('import-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    // Validate basic structure
    if (!data.tweets && !data.users) {
      showToast('Invalid backup file');
      return;
    }

    const result = await sendMessage({ type: 'IMPORT_DATABASE', data, merge: true });
    if (!result || result.error) {
      showToast('Import failed');
      return;
    }

    showToast(`Imported ${result.imported.tweets} tweets, ${result.imported.users} users`);
    await reloadAll();
  } catch (err) {
    console.error('[Dashboard] Import failed:', err);
    showToast('Import failed: Invalid file');
  }

  // Reset file input
  e.target.value = '';
});

// Delete All Data
document.getElementById('delete-all-data-btn').addEventListener('click', async () => {
  const firstConfirm = confirm('⚠ Delete ALL captured tweets, users, settings, and blog posts?\n\nThis cannot be undone.');
  if (!firstConfirm) return;

  const secondConfirm = confirm('Are you absolutely sure? All data will be permanently erased.');
  if (!secondConfirm) return;

  try {
    await sendMessage({ type: 'DELETE_ALL_DATA' });
    showToast('All data deleted');
    await reloadAll();
  } catch (err) {
    console.error('[Dashboard] Delete all failed:', err);
    showToast('Delete failed');
  }
});

// ==================== Blocked Users (Inline in Settings) ====================

async function renderBlockedListInline() {
  const blocked = await sendMessage({ type: 'GET_BLOCKED_USERS' });
  const list = document.getElementById('blocked-list-inline');
  list.innerHTML = '';

  if (!blocked || blocked.length === 0) {
    list.innerHTML = '<span style="color: #657786; font-size: 12px;">No blocked users yet.</span>';
    return;
  }

  for (const handle of blocked) {
    const tag = document.createElement('span');
    tag.className = 'blocked-tag';
    tag.innerHTML = `@${handle} <button title="Unblock">&times;</button>`;

    tag.querySelector('button').addEventListener('click', async () => {
      await sendMessage({ type: 'UNBLOCK_USER', handle });
      showToast(`Unblocked @${handle}`);
      await renderBlockedListInline();
    });

    list.appendChild(tag);
  }
}

document.getElementById('block-add-btn').addEventListener('click', async () => {
  const input = document.getElementById('block-input');
  let handle = input.value.trim().toLowerCase().replace(/^@/, '');
  if (!handle) return;

  await sendMessage({ type: 'BLOCK_USER', handle });
  input.value = '';
  showToast(`Blocked @${handle}`);
  await renderBlockedListInline();
  await reloadAll();
});

// ==================== Settings Modal ====================

document.getElementById('settings-btn').addEventListener('click', async () => {
  // Load current settings
  const settings = await sendMessage({ type: 'GET_HOME_FEED_SETTINGS' });
  const backupSettings = await sendMessage({ type: 'GET_AUTO_BACKUP_SETTINGS' });

  const enabledCheckbox = document.getElementById('home-capture-enabled');
  const thresholdsDiv = document.getElementById('home-capture-thresholds');
  const minLikesInput = document.getElementById('min-likes');
  const minImpressionsInput = document.getElementById('min-impressions');

  enabledCheckbox.checked = settings?.enabled || false;
  minLikesInput.value = settings?.minLikes || 0;
  minImpressionsInput.value = settings?.minImpressions || 0;

  // Show/hide thresholds based on enabled state
  thresholdsDiv.classList.toggle('hidden', !enabledCheckbox.checked);

  // Load auto-backup settings
  const abEnabledCheckbox = document.getElementById('auto-backup-enabled');
  abEnabledCheckbox.checked = backupSettings?.enabled || false;
  document.getElementById('auto-backup-interval').value = String(backupSettings?.intervalHours || 24);
  document.getElementById('auto-backup-options').classList.toggle('hidden', !abEnabledCheckbox.checked);
  if (backupSettings?.lastBackupAt) {
    document.getElementById('auto-backup-last').textContent = `Last backup: ${formatDate(backupSettings.lastBackupAt)}`;
  }

  // Load blocked users inline
  await renderBlockedListInline();

  document.getElementById('settings-modal-overlay').classList.remove('hidden');
});

// Toggle threshold visibility when checkbox changes
document.getElementById('home-capture-enabled').addEventListener('change', (e) => {
  document.getElementById('home-capture-thresholds').classList.toggle('hidden', !e.target.checked);
});

document.getElementById('settings-modal-close').addEventListener('click', () => {
  document.getElementById('settings-modal-overlay').classList.add('hidden');
});

document.getElementById('settings-modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

document.getElementById('settings-save-btn').addEventListener('click', async () => {
  const enabled = document.getElementById('home-capture-enabled').checked;
  const minLikes = parseInt(document.getElementById('min-likes').value, 10) || 0;
  const minImpressions = parseInt(document.getElementById('min-impressions').value, 10) || 0;

  await sendMessage({
    type: 'SET_HOME_FEED_SETTINGS',
    settings: { enabled, minLikes, minImpressions }
  });

  // Save auto-backup settings
  const autoBackupEnabled = document.getElementById('auto-backup-enabled').checked;
  const intervalHours = parseInt(document.getElementById('auto-backup-interval').value, 10) || 24;
  await sendMessage({
    type: 'SET_AUTO_BACKUP_SETTINGS',
    settings: { enabled: autoBackupEnabled, intervalHours }
  });

  document.getElementById('settings-modal-overlay').classList.add('hidden');
  showToast('Settings saved');
});

// ==================== Real-time Updates ====================

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'BOOKMARK_ADDED') {
    const el = document.getElementById('bookmark-count');
    if (el) el.textContent = `${message.count} bookmark${message.count === 1 ? '' : 's'}`;
    if (currentView === 'bookmarks') scheduleBookmarkRefresh();
    return;
  }

  if (message.type !== 'TWEET_ADDED') return;

  document.getElementById('tweet-count').textContent = `${message.totalCount} tweets`;
  refreshUserList(message.user);

  if (selectedUser === message.tweet.handle) {
    appendTweet(message.tweet);
    document.getElementById('ctx-tweet-count').textContent = `${normalizeTweetCount(message.user.tweetCount)} tweets captured`;
  }
});

// ==================== View Navigation ====================

function showView(viewName) {
  currentView = viewName;

  // Update nav items
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.view === viewName);
  });

  // Update views
  document.querySelectorAll('.view').forEach(view => {
    view.classList.toggle('active', view.id === `view-${viewName}`);
  });

  // Show/hide footer (only in users view)
  const footer = document.getElementById('tweet-footer');
  if (footer) {
    footer.classList.toggle('hidden', viewName !== 'users');
  }

  // Load view-specific data
  if (viewName === 'home') {
    loadHomeView();
  } else if (viewName === 'users') {
    loadUsersView();
  } else if (viewName === 'search') {
    document.getElementById('search-input').focus();
  } else if (viewName === 'collections') {
    loadCollectionsView();
  } else if (viewName === 'bookmarks') {
    loadBookmarksView();
  } else if (viewName === 'ai') {
    loadAIView();
  }
}

// Navigation click handlers
document.querySelectorAll('.nav-menu .nav-item').forEach(item => {
  item.addEventListener('click', () => {
    showView(item.dataset.view);
  });
});

// ==================== Home View ====================

async function loadHomeView() {
  await loadAISettings();
  await loadAIStyleUsers();

  // Load stats
  const count = await sendMessage({ type: 'GET_TWEET_COUNT' });
  const users = await sendMessage({ type: 'GET_USERS' });

  const totalTweets = count || 0;
  const totalUsers = users?.length || 0;
  const starredUsers = users?.filter(u => u.starred)?.length || 0;

  document.getElementById('stat-total-tweets').textContent = totalTweets;
  document.getElementById('stat-total-users').textContent = totalUsers;
  document.getElementById('stat-starred-users').textContent = starredUsers;
  document.getElementById('tweet-count').textContent = `${totalTweets} tweets`;

  // Load recent tweets by capture time
  const recentTweets = await sendMessage({ type: 'GET_RECENT_TWEETS', limit: 50 });
  renderRecentTweets(recentTweets || []);

  // Draw capture chart
  drawCaptureChart();

  renderHomeAISelection();
}

let recentTweetsCache = [];

function isHomeAISelectedTweetInCache() {
  if (!homeAISelectedTweet) return false;
  return recentTweetsCache.some(tweet => tweet.tweetId === homeAISelectedTweet.tweetId);
}

function syncHomeAISelectionHighlight() {
  document.querySelectorAll('#recent-tweets .grid-card').forEach((card) => {
    const isSelected = !!homeAISelectedTweet && card.dataset.tweetId === String(homeAISelectedTweet.tweetId);
    card.classList.toggle('home-ai-selected', isSelected);
  });
}

function renderHomeAISelection() {
  const selectedEl = document.getElementById('home-ai-selected');
  const generateBtn = document.getElementById('home-ai-generate-btn');
  if (!selectedEl || !generateBtn) return;

  if (!homeAISelectedTweet) {
    selectedEl.innerHTML = '<div class="home-ai-selected-empty">Click a tweet card to prepare replies.</div>';
    generateBtn.disabled = true;
    syncHomeAISelectionHighlight();
    return;
  }

  selectedEl.innerHTML = `
    <div class="home-ai-selected-handle">@${escapeHtml(homeAISelectedTweet.handle)} · ${escapeHtml(formatAITweetDate(homeAISelectedTweet))}</div>
    <div class="home-ai-selected-text">${escapeHtml(homeAISelectedTweet.fullText || '(No text)')}</div>
  `;
  generateBtn.disabled = false;
  syncHomeAISelectionHighlight();
}

function selectHomeAITweet(tweet) {
  homeAISelectedTweet = tweet;
  renderHomeAISelection();
}

function renderRecentTweets(tweets) {
  const container = document.getElementById('recent-tweets');
  container.innerHTML = '';
  recentRenderIndex = 0;

  if (recentObserver) recentObserver.disconnect();

  if (tweets.length === 0) {
    container.innerHTML = '<div class="empty-state">Browse a Twitter/X profile to start capturing tweets.</div>';
    homeAISelectedTweet = null;
    renderHomeAISelection();
    return;
  }

  // Sort by capturedAt descending
  tweets.sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));
  recentTweetsCache = tweets;
  if (!isHomeAISelectedTweetInCache()) {
    homeAISelectedTweet = null;
  }

  renderNextRecentBatch(container);
  renderHomeAISelection();
}

function renderNextRecentBatch(container) {
  const end = Math.min(recentRenderIndex + TWEET_BATCH_SIZE, recentTweetsCache.length);
  for (let i = recentRenderIndex; i < end; i++) {
    container.appendChild(createGridCard(recentTweetsCache[i], { homeAI: true }));
  }
  syncHomeAISelectionHighlight();
  recentRenderIndex = end;

  // Remove old sentinel
  const oldSentinel = container.querySelector('.recent-sentinel');
  if (oldSentinel) oldSentinel.remove();

  // Add sentinel if more tweets remain
  if (recentRenderIndex < recentTweetsCache.length) {
    const sentinel = document.createElement('div');
    sentinel.className = 'recent-sentinel';
    sentinel.style.height = '1px';
    container.appendChild(sentinel);

    recentObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        recentObserver.disconnect();
        renderNextRecentBatch(container);
      }
    }, { root: container });
    recentObserver.observe(sentinel);
  }
}

// Shared metrics HTML builder (SVG icons)
function buildMetricsHtml(tweet) {
  const metrics = [];
  if (tweet.replyCount) metrics.push(`<span class="grid-metric" title="Replies"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.25-.893 4.306-2.394 5.82l-4.36 4.36a.75.75 0 01-1.06 0l-.72-.72a.75.75 0 010-1.06l4.36-4.36A5.63 5.63 0 0020.501 10.13 6.38 6.38 0 0014.122 3.75h-4.366a6.25 6.25 0 00-6.255 6.25c0 1.903.855 3.604 2.2 4.748l.09.07a.75.75 0 01-.48 1.34H3.59a.75.75 0 01-.54-.23A7.98 7.98 0 011.751 10z" fill="currentColor"/></svg> ${formatMetricCount(tweet.replyCount)}</span>`);
  if (tweet.retweetCount) metrics.push(`<span class="grid-metric" title="Reposts"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2h3v2h-3c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM19.5 20.12l-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2h-3V4h3c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14z" fill="currentColor"/></svg> ${formatMetricCount(tweet.retweetCount)}</span>`);
  if (tweet.likeCount) metrics.push(`<span class="grid-metric" title="Likes"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.56-1.13-1.666-1.84-2.908-1.91z" fill="currentColor"/></svg> ${formatMetricCount(tweet.likeCount)}</span>`);
  if (tweet.bookmarkCount) metrics.push(`<span class="grid-metric" title="Bookmarks"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5z" fill="currentColor"/></svg> ${formatMetricCount(tweet.bookmarkCount)}</span>`);
  if (tweet.viewCount || tweet.impressionCount) metrics.push(`<span class="grid-metric" title="Views"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M8.75 21V3h2v18h-2zM18.75 21V8.5h2V21h-2zM13.75 21v-9h2v9h-2zM3.75 21v-4h2v4h-2z" fill="currentColor"/></svg> ${formatMetricCount(tweet.viewCount || tweet.impressionCount)}</span>`);
  return metrics.length > 0 ? `<div class="grid-metrics">${metrics.join('')}</div>` : '';
}

// Shared avatar HTML builder
function buildAvatarHtml(tweet) {
  return tweet.avatarUrl
    ? `<img class="grid-avatar" src="${escapeHtml(tweet.avatarUrl)}" alt="@${escapeHtml(tweet.handle)}">`
    : `<div class="grid-avatar grid-avatar-placeholder">${escapeHtml(tweet.handle.charAt(0).toUpperCase())}</div>`;
}

// Shared media HTML builder
function buildMediaHtml(tweet) {
  if (!tweet.mediaUrls || tweet.mediaUrls.length === 0) return '';

  const mediaHtml = tweet.mediaUrls.map(url => {
    return `<img src="${escapeHtml(url)}" class="grid-media-thumbnail" alt="Tweet media" loading="lazy">`;
  }).join('');

  let linkCardHtml = '';
  if (tweet.linkCard) {
    linkCardHtml = `<a href="${escapeHtml(tweet.linkCard.url)}" target="_blank" class="grid-link-card">
      <span class="grid-link-card-domain">${escapeHtml(tweet.linkCard.domain)}</span>
      <span class="grid-link-card-title">${escapeHtml(tweet.linkCard.title)}</span>
    </a>`;
  }

  return `<div class="grid-media-container">${mediaHtml}${linkCardHtml}</div>`;
}

function createGridCard(tweet, { selectable = false, homeAI = false } = {}) {
  const card = document.createElement('div');
  card.className = 'grid-card';
  card.dataset.tweetId = tweet.tweetId;
  if (homeAI && homeAISelectedTweet && homeAISelectedTweet.tweetId === tweet.tweetId) {
    card.classList.add('home-ai-selected');
  }

  let retweetHtml = '';
  if (tweet.isRetweet && tweet.retweetedBy) {
    retweetHtml = `<div class="retweet-badge">Reposted by @${escapeHtml(tweet.retweetedBy)}</div>`;
  }

  const deleteBtn = selectable ? `<button class="grid-card-delete" title="Delete tweet">\u00d7</button>` : '';
  const checkboxHtml = selectable ? `<input type="checkbox" class="grid-card-checkbox tweet-checkbox" value="${escapeHtml(tweet.tweetId)}">` : '';
  const homeAIActionHtml = homeAI
    ? `<div class="grid-card-home-ai-action"><button type="button" class="grid-card-ai-btn">Generate Replies</button></div>`
    : '';

  card.innerHTML = `
    ${retweetHtml}
    <div class="grid-card-header">
      ${buildAvatarHtml(tweet)}
      <div class="grid-card-user">
        <span class="grid-card-name">${escapeHtml(tweet.displayName)}</span>
        <span class="grid-card-handle">@${escapeHtml(tweet.handle)} &middot; ${formatTimestamp(tweet.timestamp)}</span>
      </div>
      <a href="${escapeHtml(tweet.url)}" target="_blank" class="grid-card-link" title="Open on X">&#x2197;</a>
      ${deleteBtn}
    </div>
    ${tweet.isThread ? '<div class="thread-badge">🧵 Thread</div>' : ''}
    ${tweet.inReplyToId && !tweet.isThread ? '<div class="reply-badge">↩️ Reply</div>' : ''}
    ${tweet.fullText ? `<div class="grid-card-text">${escapeHtml(tweet.fullText)}</div>` : '<div class="grid-card-text grid-card-text-empty">No text captured</div>'}
    ${buildMediaHtml(tweet)}
    ${buildMetricsHtml(tweet)}
    ${homeAIActionHtml}
    ${checkboxHtml}
  `;

  if (selectable) {
    const checkbox = card.querySelector('.grid-card-checkbox');
    if (checkbox) {
      checkbox.addEventListener('change', () => {
        card.classList.toggle('selected', checkbox.checked);
      });
    }

    const delBtn = card.querySelector('.grid-card-delete');
    if (delBtn) {
      delBtn.addEventListener('click', () => deleteTweetNow(tweet, card));
    }

    // Tag button
    const tagBtn = document.createElement('button');
    tagBtn.className = 'grid-card-tag-btn';
    tagBtn.textContent = '🏷️';
    tagBtn.title = 'Add tag';
    tagBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showTagPopover(tweet, tagBtn);
    });
    card.querySelector('.grid-card-header').appendChild(tagBtn);
  }

  if (homeAI) {
    card.addEventListener('click', (e) => {
      if (e.target.closest('a, button, input, textarea, select')) return;
      selectHomeAITweet(tweet);
    });

    const aiBtn = card.querySelector('.grid-card-ai-btn');
    if (aiBtn) {
      aiBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        selectHomeAITweet(tweet);
        const triggerBtn = document.getElementById('home-ai-generate-btn');
        if (triggerBtn && !triggerBtn.disabled) {
          triggerBtn.click();
        }
      });
    }
  }

  return card;
}

// Alias for backward compat
function createTweetCard(tweet, isReadOnly = false) {
  return createGridCard(tweet, { selectable: !isReadOnly });
}

// ==================== Users View ====================

async function loadUsersView() {
  const users = await sendMessage({ type: 'GET_USERS' });
  if (users && users.length > 0) {
    renderUserList(users);
    if (!selectedUser) {
      selectUser(users[0].handle);
    }
  } else {
    renderUserList([]);
    document.getElementById('tweet-list').innerHTML = '<div class="empty-state">No users tracked yet.</div>';
  }
}

// ==================== Search View ====================

document.getElementById('search-input').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(async () => {
    const query = e.target.value.trim();
    const container = document.getElementById('search-results');

    if (query.length < 2) {
      container.innerHTML = '<div class="empty-state">Enter a search term to find tweets.</div>';
      return;
    }

    const results = await sendMessage({ type: 'SEARCH_TWEETS', query, limit: 500 });
    container.innerHTML = '';

    if (!results || results.length === 0) {
      container.innerHTML = '<div class="empty-state">No tweets found.</div>';
      return;
    }

    for (const tweet of results) {
      container.appendChild(createTweetCard(tweet, true));
    }
  }, 300);
});

let searchDebounce;

// ==================== AI Replies View ====================

let aiSelectedTweets = [];
let aiSearchDebounce = null;
let aiStyleUsers = [];
let aiStyleRecentHandles = [];
let aiLastGenerationTweets = [];
const AI_STYLE_RECENT_LIMIT = 8;

function normalizeAIHandle(raw) {
  if (!raw) return '';
  const value = String(raw).trim().toLowerCase();
  const match = value.match(/@?([a-z0-9_]{1,15})/i);
  return match ? match[1].toLowerCase() : '';
}

function sanitizeAIStyleRecentHandles(handles) {
  if (!Array.isArray(handles)) return [];
  const seen = new Set();
  const result = [];

  for (const item of handles) {
    const handle = normalizeAIHandle(item);
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    result.push(handle);
    if (result.length >= AI_STYLE_RECENT_LIMIT) break;
  }

  return result;
}

function getAIStyleInputHandleRaw(inputId = 'ai-style-user-input') {
  const input = document.getElementById(inputId);
  return normalizeAIHandle(input?.value || '');
}

function isKnownAIStyleHandle(handle) {
  const normalized = normalizeAIHandle(handle);
  if (!normalized) return false;
  return aiStyleUsers.some(user => (user.handle || '').toLowerCase() === normalized);
}

function getSelectedAIStyleHandle(inputId = 'ai-style-user-input') {
  const handle = getAIStyleInputHandleRaw(inputId);
  return isKnownAIStyleHandle(handle) ? handle : '';
}

function setSelectedAIStyleHandle(handle, inputId = 'ai-style-user-input') {
  const input = document.getElementById(inputId);
  if (!input) return;
  const normalized = normalizeAIHandle(handle);
  input.value = normalized ? `@${normalized}` : '';
}

function sortAIStyleUsers() {
  const recentRank = new Map(aiStyleRecentHandles.map((handle, idx) => [handle, idx]));

  return [...aiStyleUsers].sort((a, b) => {
    const handleA = normalizeAIHandle(a.handle);
    const handleB = normalizeAIHandle(b.handle);

    const rankA = recentRank.has(handleA) ? recentRank.get(handleA) : Number.POSITIVE_INFINITY;
    const rankB = recentRank.has(handleB) ? recentRank.get(handleB) : Number.POSITIVE_INFINITY;

    if (rankA !== rankB) return rankA - rankB;
    return handleA.localeCompare(handleB);
  });
}

function renderAIStyleUserOptions() {
  const optionLists = [
    document.getElementById('ai-style-user-options'),
    document.getElementById('home-ai-style-user-options')
  ].filter(Boolean);

  for (const options of optionLists) {
    options.innerHTML = '';
  }

  const sortedUsers = sortAIStyleUsers();

  for (const user of sortedUsers) {
    const handle = normalizeAIHandle(user.handle);
    if (!handle) continue;

    for (const options of optionLists) {
      const option = document.createElement('option');
      option.value = `@${handle}`;
      if (user.displayName) {
        option.label = user.displayName;
      }
      options.appendChild(option);
    }
  }
}

function renderAIStyleRecentsFor(containerId, inputId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const visibleRecents = aiStyleRecentHandles
    .filter(handle => isKnownAIStyleHandle(handle))
    .slice(0, AI_STYLE_RECENT_LIMIT);

  container.innerHTML = '';
  if (visibleRecents.length === 0) return;

  const label = document.createElement('span');
  label.className = 'ai-style-recents-label';
  label.textContent = 'Recent';
  container.appendChild(label);

  for (const handle of visibleRecents) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-style-recent-btn';
    btn.textContent = `@${handle}`;
    btn.addEventListener('click', () => {
      setSelectedAIStyleHandle(handle, inputId);
      setSelectedAIStyleHandle(handle, inputId === 'ai-style-user-input' ? 'home-ai-style-user-input' : 'ai-style-user-input');
      document.getElementById(inputId)?.focus();
    });
    container.appendChild(btn);
  }
}

function renderAIStyleRecents() {
  renderAIStyleRecentsFor('ai-style-recents', 'ai-style-user-input');
  renderAIStyleRecentsFor('home-ai-style-recents', 'home-ai-style-user-input');
}

async function persistAIStyleRecents() {
  try {
    const settings = await sendMessage({ type: 'GET_AI_SETTINGS' });
    if (!settings || settings.error) return;

    await sendMessage({
      type: 'SET_AI_SETTINGS',
      settings: {
        ...settings,
        recentStyleUsers: aiStyleRecentHandles
      }
    });
  } catch {
    // Ignore persistence failures for recents.
  }
}

async function registerAIStyleUsage(handle) {
  const normalized = normalizeAIHandle(handle);
  if (!normalized) return;

  aiStyleRecentHandles = [
    normalized,
    ...aiStyleRecentHandles.filter(item => item !== normalized)
  ].slice(0, AI_STYLE_RECENT_LIMIT);

  renderAIStyleUserOptions();
  renderAIStyleRecents();
  await persistAIStyleRecents();
}

function getTweetSortTime(tweet) {
  if (!tweet) return 0;
  const primary = tweet.timestamp || tweet.capturedAt;
  const time = Date.parse(primary || '');
  if (!Number.isNaN(time)) return time;

  const fallback = Date.parse(tweet.capturedAt || '');
  return Number.isNaN(fallback) ? 0 : fallback;
}

function sortTweetsNewestFirst(tweets = []) {
  return [...tweets].sort((a, b) => getTweetSortTime(b) - getTweetSortTime(a));
}

function getTweetPermalink(tweet) {
  const handle = String(tweet?.handle || '').trim().replace(/^@/, '');
  const tweetId = String(tweet?.tweetId || '').trim();
  if (!handle || !tweetId) return '';

  return `https://x.com/${encodeURIComponent(handle)}/status/${encodeURIComponent(tweetId)}`;
}

function formatAITweetDate(tweet) {
  const raw = tweet?.timestamp || tweet?.capturedAt;
  if (!raw) return 'Unknown date';

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return 'Unknown date';

  const nowMs = Date.now();
  const tweetMs = date.getTime();
  const diffMs = nowMs - tweetMs;
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (diffMs >= 0 && diffMs < oneDayMs) {
    const totalMinutes = Math.floor(diffMs / 60000);
    if (totalMinutes < 1) return 'since just now';

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours > 0 && minutes > 0) return `since ${hours}h ${minutes}m ago`;
    if (hours > 0) return `since ${hours}h ago`;
    return `since ${minutes}m ago`;
  }

  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function estimateTokenCount(text) {
  const clean = String(text || '').trim();
  if (!clean) return 0;

  const byChars = Math.ceil(clean.length / 4);
  const byWords = Math.ceil(clean.split(/\s+/).filter(Boolean).length * 1.25);
  return Math.max(1, Math.round((byChars + byWords) / 2));
}

function createAIReplyOption(replyText) {
  const cleanReply = String(replyText || '').trim();
  const option = document.createElement('div');
  option.className = 'ai-reply-option';

  const text = document.createElement('div');
  text.className = 'ai-reply-text';
  text.textContent = cleanReply;
  option.appendChild(text);

  const actions = document.createElement('div');
  actions.className = 'ai-copy-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'ai-copy-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(cleanReply);
    copyBtn.textContent = 'Copied!';
    copyBtn.classList.add('copied');
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
      copyBtn.classList.remove('copied');
    }, 1500);
  });
  actions.appendChild(copyBtn);

  const tokenCount = document.createElement('div');
  tokenCount.className = 'ai-token-count';
  tokenCount.textContent = `${estimateTokenCount(cleanReply)} tokens`;
  actions.appendChild(tokenCount);

  option.appendChild(actions);
  return option;
}

async function loadAIStyleUsers() {
  const currentMainValue = getAIStyleInputHandleRaw('ai-style-user-input');
  const currentHomeValue = getAIStyleInputHandleRaw('home-ai-style-user-input');
  const users = await sendMessage({ type: 'GET_USERS' });

  aiStyleUsers = Array.isArray(users) ? users : [];

  renderAIStyleUserOptions();
  renderAIStyleRecents();

  if (isKnownAIStyleHandle(currentMainValue)) {
    setSelectedAIStyleHandle(currentMainValue, 'ai-style-user-input');
  } else if (isKnownAIStyleHandle(selectedUser)) {
    setSelectedAIStyleHandle(selectedUser, 'ai-style-user-input');
  } else if (isKnownAIStyleHandle(aiStyleRecentHandles[0])) {
    setSelectedAIStyleHandle(aiStyleRecentHandles[0], 'ai-style-user-input');
  }

  if (isKnownAIStyleHandle(currentHomeValue)) {
    setSelectedAIStyleHandle(currentHomeValue, 'home-ai-style-user-input');
  } else if (isKnownAIStyleHandle(getAIStyleInputHandleRaw('ai-style-user-input'))) {
    setSelectedAIStyleHandle(getAIStyleInputHandleRaw('ai-style-user-input'), 'home-ai-style-user-input');
  } else if (isKnownAIStyleHandle(aiStyleRecentHandles[0])) {
    setSelectedAIStyleHandle(aiStyleRecentHandles[0], 'home-ai-style-user-input');
  }
}

// Toggle settings panel
document.getElementById('ai-settings-toggle').addEventListener('click', () => {
  document.getElementById('ai-settings-panel').classList.toggle('hidden');
});

// Save AI settings
document.getElementById('ai-save-settings').addEventListener('click', async () => {
  const apiKey = document.getElementById('ai-api-key').value.trim();
  const provider = document.getElementById('ai-provider').value;
  const model = document.getElementById('ai-model').value.trim() || 'gemini-3.0-pro';
  const systemPrompt = document.getElementById('ai-system-prompt').value.trim();

  await sendMessage({
    type: 'SET_AI_SETTINGS',
    settings: { apiKey, provider, model, systemPrompt, recentStyleUsers: aiStyleRecentHandles }
  });

  document.getElementById('ai-settings-panel').classList.add('hidden');
  showToast('AI settings saved');
});

// Load AI settings into form
async function loadAISettings() {
  const settings = await sendMessage({ type: 'GET_AI_SETTINGS' });
  if (settings) {
    document.getElementById('ai-api-key').value = settings.apiKey || '';
    document.getElementById('ai-provider').value = settings.provider || 'openai';
    document.getElementById('ai-model').value = settings.model || 'gemini-3.0-pro';
    document.getElementById('ai-system-prompt').value = settings.systemPrompt || '';
    aiStyleRecentHandles = sanitizeAIStyleRecentHandles(settings.recentStyleUsers);
  }
}

document.getElementById('ai-style-user-input').addEventListener('change', () => {
  const handle = getSelectedAIStyleHandle('ai-style-user-input');
  if (!handle) return;
  setSelectedAIStyleHandle(handle, 'ai-style-user-input');
  setSelectedAIStyleHandle(handle, 'home-ai-style-user-input');
  registerAIStyleUsage(handle);
});

document.getElementById('home-ai-style-user-input').addEventListener('change', () => {
  const handle = getSelectedAIStyleHandle('home-ai-style-user-input');
  if (!handle) return;
  setSelectedAIStyleHandle(handle, 'home-ai-style-user-input');
  setSelectedAIStyleHandle(handle, 'ai-style-user-input');
  registerAIStyleUsage(handle);
});

// Load recent tweets into AI tweet browser
document.getElementById('ai-load-recent').addEventListener('click', async () => {
  const tweets = await sendMessage({ type: 'GET_RECENT_TWEETS', limit: 50 });
  renderAITweetList(tweets || []);
});

// Search tweets in AI view
document.getElementById('ai-tweet-search').addEventListener('input', (e) => {
  clearTimeout(aiSearchDebounce);
  aiSearchDebounce = setTimeout(async () => {
    const query = e.target.value.trim();
    if (query.length < 2) {
      // Load recent if search cleared
      const tweets = await sendMessage({ type: 'GET_RECENT_TWEETS', limit: 50 });
      renderAITweetList(tweets || []);
      return;
    }
    const results = await sendMessage({ type: 'SEARCH_TWEETS', query, limit: 50 });
    renderAITweetList(results || []);
  }, 300);
});

function renderAITweetList(tweets) {
  const container = document.getElementById('ai-tweet-list');
  container.innerHTML = '';

  if (tweets.length === 0) {
    container.innerHTML = '<div class="empty-state">No tweets found.</div>';
    return;
  }

  const sortedTweets = sortTweetsNewestFirst(tweets);

  for (const tweet of sortedTweets) {
    const tweetHandle = tweet.handle || 'unknown';
    const tweetName = tweet.displayName || tweetHandle;
    const tweetUrl = getTweetPermalink(tweet);
    const item = document.createElement('div');
    item.className = 'ai-tweet-item';
    item.dataset.tweetId = String(tweet.tweetId || '');
    if (aiSelectedTweets.some(t => t.tweetId === tweet.tweetId)) {
      item.classList.add('selected');
    }

    const avatarHtml = tweet.avatarUrl
      ? `<img class="ai-tweet-item-avatar" src="${escapeHtml(tweet.avatarUrl)}" alt="@${escapeHtml(tweetHandle)}">`
      : `<div class="ai-tweet-item-avatar-placeholder">${escapeHtml(tweetHandle.charAt(0).toUpperCase())}</div>`;
    const tweetDate = formatAITweetDate(tweet);

    item.innerHTML = `
      ${avatarHtml}
      <div class="ai-tweet-item-content">
        <div class="ai-tweet-item-header">
          <span class="ai-tweet-item-name">${escapeHtml(tweetName)}</span>
          <span class="ai-tweet-item-handle">@${escapeHtml(tweetHandle)}</span>
          <span class="ai-tweet-item-date">${escapeHtml(tweetDate)}</span>
          ${tweetUrl
        ? `<a class="ai-open-x-link" href="${escapeHtml(tweetUrl)}" target="_blank" rel="noopener noreferrer" title="Open on X">↗</a>`
        : ''
      }
        </div>
        <div class="ai-tweet-item-text">${escapeHtml(tweet.fullText || '')}</div>
      </div>
      <div class="ai-tweet-item-check"></div>
    `;

    const openLink = item.querySelector('.ai-open-x-link');
    if (openLink) {
      openLink.addEventListener('click', (e) => e.stopPropagation());
      openLink.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    item.addEventListener('click', () => toggleAITweetSelection(tweet, item));
    container.appendChild(item);
  }
}

function toggleAITweetSelection(tweet, itemEl) {
  aiLastGenerationTweets = [];
  const idx = aiSelectedTweets.findIndex(t => t.tweetId === tweet.tweetId);
  if (idx >= 0) {
    aiSelectedTweets.splice(idx, 1);
    itemEl.classList.remove('selected');
  } else {
    aiSelectedTweets.push(tweet);
    itemEl.classList.add('selected');
  }
  updateAISelectedDisplay();
}

function updateAISelectedDisplay() {
  document.getElementById('ai-selected-count').textContent = aiSelectedTweets.length;

  const container = document.getElementById('ai-selected-tweets');
  container.innerHTML = '';

  const sortedSelectedTweets = sortTweetsNewestFirst(aiSelectedTweets);

  for (const tweet of sortedSelectedTweets) {
    const chip = document.createElement('span');
    chip.className = 'ai-selected-chip';

    const textSpan = document.createElement('span');
    textSpan.className = 'ai-selected-chip-text';
    const dateLabel = formatAITweetDate(tweet);
    const preview = tweet.fullText
      ? `@${tweet.handle} · ${dateLabel}: ${tweet.fullText.slice(0, 60)}${tweet.fullText.length > 60 ? '...' : ''}`
      : `@${tweet.handle}`;
    textSpan.textContent = preview;
    chip.appendChild(textSpan);

    const tweetUrl = getTweetPermalink(tweet);
    if (tweetUrl) {
      const openLink = document.createElement('a');
      openLink.className = 'ai-selected-chip-open';
      openLink.href = tweetUrl;
      openLink.target = '_blank';
      openLink.rel = 'noopener noreferrer';
      openLink.title = 'Open on X';
      openLink.textContent = '↗';
      chip.appendChild(openLink);
    }

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', () => {
      aiSelectedTweets = aiSelectedTweets.filter(t => t.tweetId !== tweet.tweetId);
      updateAISelectedDisplay();
      document.querySelectorAll('.ai-tweet-item').forEach(el => {
        if (el.dataset.tweetId === String(tweet.tweetId || '')) {
          el.classList.remove('selected');
        }
      });
    });
    chip.appendChild(removeBtn);
    container.appendChild(chip);
  }
}

// Clear selected
document.getElementById('ai-clear-selected').addEventListener('click', () => {
  aiLastGenerationTweets = [];
  aiSelectedTweets = [];
  updateAISelectedDisplay();
  document.querySelectorAll('.ai-tweet-item.selected').forEach(el => el.classList.remove('selected'));
});

async function runAIReplyGeneration({
  selectedTweets,
  styleHandle,
  customPrompt,
  buttonEl,
  resultsContainer,
  styleInputId
}) {
  const settings = await sendMessage({ type: 'GET_AI_SETTINGS' });
  if (!settings?.apiKey) {
    showToast('Set your API key in AI Settings first');
    document.getElementById('ai-settings-panel').classList.remove('hidden');
    return false;
  }

  const defaultText = buttonEl.dataset.defaultText || buttonEl.textContent || 'Generate Replies';

  buttonEl.disabled = true;
  buttonEl.classList.add('loading');
  buttonEl.textContent = 'Generating...';
  resultsContainer.innerHTML = '<div class="empty-state">Generating reply ideas...</div>';

  try {
    const styleUserTweets = await sendMessage({ type: 'GET_ALL_TWEETS_FOR_USER', handle: styleHandle });
    const styleSamples = sortTweetsNewestFirst(styleUserTweets || [])
      .filter(tweet => (tweet.fullText || '').trim().length > 0)
      .slice(0, 40);

    if (styleSamples.length === 0) {
      showToast(`No tweets found for @${styleHandle} to learn style from`);
      resultsContainer.innerHTML = '<div class="empty-state">No style tweets found for selected user.</div>';
      return false;
    }

    const mirrorInputId = styleInputId === 'ai-style-user-input'
      ? 'home-ai-style-user-input'
      : 'ai-style-user-input';

    setSelectedAIStyleHandle(styleHandle, styleInputId);
    setSelectedAIStyleHandle(styleHandle, mirrorInputId);
    await registerAIStyleUsage(styleHandle);

    aiLastGenerationTweets = sortTweetsNewestFirst(selectedTweets);

    const tweetsContext = aiLastGenerationTweets.map((t, i) =>
      `[Tweet ${i + 1} | ${formatAITweetDate(t)}] @${t.handle} (${t.displayName || t.handle}):\n${t.fullText || '(no text)'}`
    ).join('\n\n---\n\n');

    const styleContext = styleSamples.map((t, i) =>
      `[Style Sample ${i + 1} | ${formatAITweetDate(t)}]\n${t.fullText}`
    ).join('\n\n---\n\n');

    const styleUser = aiStyleUsers.find(user => normalizeAIHandle(user.handle) === styleHandle);
    const styleDescriptor = styleUser?.displayName
      ? `@${styleHandle} (${styleUser.displayName})`
      : `@${styleHandle}`;

    const taskPrompt = customPrompt || 'Generate 2-3 replies for each target tweet.';

    const userPrompt = `
Write all replies in the style of ${styleDescriptor}.

Here are writing samples for style matching:
${styleContext}

Here are the target tweets:
${tweetsContext}

Task:
${taskPrompt}

Requirements:
- Match the selected style's cadence, punctuation, and directness.
- Do not force wit or jokes unless the style samples show that naturally.
- Keep every reply concise and under 280 characters.
- Return ONLY valid JSON array format: [{"tweetIndex": 1, "replies": ["reply1", "reply2"]}, ...]
`.trim();

    const baseSystemPrompt = settings.systemPrompt ||
      'You generate concise Twitter/X replies. Follow the provided style samples closely and keep responses natural.';
    const systemPrompt = `${baseSystemPrompt}
Always mirror the provided style samples.
Do not force wit or humor unless the style samples show it.

IMPORTANT: Always respond with valid JSON array format: [{"tweetIndex": 1, "replies": ["reply1", "reply2"]}, ...]`;

    const provider = settings.provider || 'openai';
    let apiUrl, headers, body;

    if (provider === 'gemini') {
      const model = settings.model || 'gemini-3.0-pro';
      apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.apiKey}`;
      headers = {
        'Content-Type': 'application/json'
      };
      body = JSON.stringify({
        system_instruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: [
          { role: 'user', parts: [{ text: userPrompt }] }
        ],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 2000,
          responseMimeType: "application/json"
        }
      });
    } else {
      if (provider === 'openrouter') {
        apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
        headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${settings.apiKey}`
        };
      } else {
        apiUrl = 'https://api.openai.com/v1/chat/completions';
        headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${settings.apiKey}`
        };
      }

      body = JSON.stringify({
        model: settings.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.8,
        max_tokens: 2000
      });
    }

    const response = await fetch(apiUrl, { method: 'POST', headers, body });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error?.message || `API error: ${response.status}`);
    }

    const data = await response.json();
    let content = '';

    if (provider === 'gemini') {
      content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      content = data.choices?.[0]?.message?.content || '';
    }

    renderAIResults(content, { container: resultsContainer, tweetsForResults: aiLastGenerationTweets });
    return true;
  } catch (err) {
    console.error('[X-Vault] AI generation failed:', err);
    resultsContainer.innerHTML = `<div class="ai-error">Error: ${escapeHtml(err.message)}</div>`;
    return false;
  } finally {
    buttonEl.disabled = false;
    buttonEl.classList.remove('loading');
    buttonEl.textContent = defaultText;
  }
}

// Generate replies (full AI view)
document.getElementById('ai-generate-btn').addEventListener('click', async () => {
  if (aiSelectedTweets.length === 0) {
    showToast('Select at least one tweet');
    return;
  }

  const styleHandle = getSelectedAIStyleHandle('ai-style-user-input');
  if (!styleHandle) {
    showToast('Choose a valid user in "Which user are you?"');
    return;
  }

  await runAIReplyGeneration({
    selectedTweets: aiSelectedTweets,
    styleHandle,
    customPrompt: document.getElementById('ai-prompt-input').value.trim(),
    buttonEl: document.getElementById('ai-generate-btn'),
    resultsContainer: document.getElementById('ai-results'),
    styleInputId: 'ai-style-user-input'
  });
});

// Generate replies (compact Home sidebar)
document.getElementById('home-ai-generate-btn').addEventListener('click', async () => {
  if (!homeAISelectedTweet) {
    showToast('Click a tweet first');
    return;
  }

  const styleHandle = getSelectedAIStyleHandle('home-ai-style-user-input');
  if (!styleHandle) {
    showToast('Choose a valid user in "Which user are you?"');
    return;
  }

  await runAIReplyGeneration({
    selectedTweets: [homeAISelectedTweet],
    styleHandle,
    customPrompt: document.getElementById('home-ai-prompt-input').value.trim(),
    buttonEl: document.getElementById('home-ai-generate-btn'),
    resultsContainer: document.getElementById('home-ai-results'),
    styleInputId: 'home-ai-style-user-input'
  });
});

function renderAIResults(content, { container = document.getElementById('ai-results'), tweetsForResults = null } = {}) {
  container.innerHTML = '';
  const effectiveTweetsForResults = tweetsForResults || (aiLastGenerationTweets.length > 0
    ? aiLastGenerationTweets
    : sortTweetsNewestFirst(aiSelectedTweets));

  // Try to parse as JSON first
  let parsed = null;
  try {
    // Extract JSON from markdown code blocks if wrapped
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
    parsed = JSON.parse(jsonMatch[1].trim());
  } catch (e) {
    // Fallback: render as plain text with copy buttons
    renderAIResultsPlainText(container, content);
    return;
  }

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const tweetIdx = (item.tweetIndex || 1) - 1;
      const tweet = effectiveTweetsForResults[tweetIdx];

      const card = document.createElement('div');
      card.className = 'ai-result-card';

      if (tweet) {
        const ref = document.createElement('div');
        ref.className = 'ai-result-tweet-ref';
        const tweetUrl = getTweetPermalink(tweet);
        const handleHtml = tweetUrl
          ? `<a class="ai-result-x-link" href="${escapeHtml(tweetUrl)}" target="_blank" rel="noopener noreferrer"><strong>@${escapeHtml(tweet.handle)}</strong> ↗</a>`
          : `<strong>@${escapeHtml(tweet.handle)}</strong>`;
        ref.innerHTML = `${handleHtml} · ${escapeHtml(formatAITweetDate(tweet))}: ${escapeHtml(tweet.fullText || '')}`;
        card.appendChild(ref);
      }

      const replies = Array.isArray(item.replies) ? item.replies : [];
      for (const reply of replies) {
        card.appendChild(createAIReplyOption(reply));
      }

      container.appendChild(card);
    }
  } else {
    renderAIResultsPlainText(container, content);
  }
}

function renderAIResultsPlainText(container, content) {
  // Split by lines that look like replies (starting with - or numbered)
  const lines = content.split('\n').filter(l => l.trim());
  let currentCard = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect tweet reference headers (e.g. "Tweet 1:" or "[Tweet 1]" or "**@handle**")
    if (/^(\[?tweet\s*\d+\]?|#{1,3}\s|.*@\w+.*:)/i.test(trimmed)) {
      currentCard = document.createElement('div');
      currentCard.className = 'ai-result-card';
      const ref = document.createElement('div');
      ref.className = 'ai-result-tweet-ref';
      ref.textContent = trimmed.replace(/^#+\s*/, '').replace(/\*\*/g, '');
      currentCard.appendChild(ref);
      container.appendChild(currentCard);
      continue;
    }

    // Reply lines (starting with - or number.)
    const replyMatch = trimmed.match(/^[-*]\s+(.+)/) || trimmed.match(/^\d+[.)]\s+(.+)/);
    if (replyMatch) {
      if (!currentCard) {
        currentCard = document.createElement('div');
        currentCard.className = 'ai-result-card';
        container.appendChild(currentCard);
      }
      currentCard.appendChild(createAIReplyOption(replyMatch[1].replace(/^["']|["']$/g, '')));
    }
  }

  // If nothing was parsed, show raw content
  if (container.children.length === 0) {
    const card = document.createElement('div');
    card.className = 'ai-result-card';
    card.appendChild(createAIReplyOption(content));
    container.appendChild(card);
  }
}

async function loadAIView() {
  await loadAISettings();
  await loadAIStyleUsers();
  aiLastGenerationTweets = [];
  // Auto-load recent tweets
  const tweets = await sendMessage({ type: 'GET_RECENT_TWEETS', limit: 50 });
  renderAITweetList(tweets || []);
}

// ==================== Keyboard Shortcuts ====================

document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  const tag = (e.target.tagName || '').toLowerCase();
  const isInput = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

  // Escape — close modals / deselect user
  if (e.key === 'Escape') {
    // Close any visible overlay/modal
    const settingsPanel = document.getElementById('settings-view');
    if (settingsPanel && !settingsPanel.classList.contains('hidden')) {
      showView(currentView === 'settings' ? 'home' : currentView);
      return;
    }
    // Deselect user
    if (selectedUser) {
      selectedUser = null;
      selectedUserData = null;
      hideUserContext();
      return;
    }
  }

  // Don't hijack when typing in inputs
  if (isInput) return;

  // Cmd/Ctrl + K — focus search
  if (meta && e.key === 'k') {
    e.preventDefault();
    showView('search');
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.focus();
    return;
  }

  // Cmd/Ctrl + 1-4 — switch views
  if (meta && e.key >= '1' && e.key <= '5') {
    e.preventDefault();
    const views = ['home', 'users', 'search', 'collections', 'ai'];
    const idx = parseInt(e.key) - 1;
    if (views[idx]) showView(views[idx]);
    return;
  }

  // Cmd/Ctrl + E — export selected tweets
  if (meta && e.key === 'e') {
    e.preventDefault();
    const copyBtn = document.getElementById('copy-selected');
    if (copyBtn && !copyBtn.classList.contains('hidden')) {
      copyBtn.click();
    }
    return;
  }
});

// ==================== Tag Popover ====================

function showTagPopover(tweet, anchorEl) {
  // Remove any existing popover
  document.querySelectorAll('.tag-popover').forEach(el => el.remove());

  const popover = document.createElement('div');
  popover.className = 'tag-popover';
  popover.innerHTML = `
    <input type="text" class="tag-popover-input" placeholder="Add tag..." autofocus>
    <div class="tag-popover-existing">Loading...</div>
  `;

  anchorEl.parentElement.appendChild(popover);
  const input = popover.querySelector('.tag-popover-input');
  input.focus();

  // Load existing tags for this tweet
  sendMessage({ type: 'GET_TWEET_TAGS', tweetId: tweet.tweetId }).then(tags => {
    const container = popover.querySelector('.tag-popover-existing');
    if (!tags || tags.length === 0) {
      container.textContent = '';
      return;
    }
    container.innerHTML = tags.map(tag =>
      `<span class="tag-chip">${escapeHtml(tag)} <button data-tag="${escapeHtml(tag)}">&times;</button></span>`
    ).join('');
    container.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await sendMessage({ type: 'UNTAG_TWEET', tweetId: tweet.tweetId, tag: btn.dataset.tag });
        btn.closest('.tag-chip').remove();
        showToast(`Removed tag: ${btn.dataset.tag}`);
      });
    });
  });

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const tag = input.value.trim();
      if (!tag) return;
      await sendMessage({ type: 'TAG_TWEET', tweetId: tweet.tweetId, tag });
      showToast(`Tagged: ${tag}`);
      popover.remove();
    } else if (e.key === 'Escape') {
      popover.remove();
    }
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function closePopover(e) {
      if (!popover.contains(e.target) && e.target !== anchorEl) {
        popover.remove();
        document.removeEventListener('click', closePopover);
      }
    });
  }, 0);
}

// ==================== Collections View ====================

// ==================== Bookmarks View ====================

let bookmarksCache = [];
let bookmarkFilter = '';
let bookmarkRefreshTimer = null;

async function loadBookmarksView() {
  const bookmarks = await sendMessage({ type: 'GET_BOOKMARKS' });
  bookmarksCache = bookmarks || [];
  renderBookmarks();
}

function updateBookmarkCount() {
  const el = document.getElementById('bookmark-count');
  if (el) el.textContent = `${bookmarksCache.length} bookmark${bookmarksCache.length === 1 ? '' : 's'}`;
}

function renderBookmarks() {
  const container = document.getElementById('bookmark-list');
  updateBookmarkCount();
  container.innerHTML = '';

  const filter = bookmarkFilter.toLowerCase();
  const filtered = filter
    ? bookmarksCache.filter(b =>
      (b.fullText || '').toLowerCase().includes(filter) ||
      (b.handle || '').toLowerCase().includes(filter) ||
      (b.displayName || '').toLowerCase().includes(filter))
    : bookmarksCache;

  if (filtered.length === 0) {
    container.innerHTML = bookmarksCache.length === 0
      ? '<div class="empty-state">No bookmarks yet. Click "Sync from X" to grab them.</div>'
      : '<div class="empty-state">No bookmarks match your filter.</div>';
    return;
  }

  // Render defensively: a single malformed bookmark record must not abort
  // the whole loop (which would silently truncate the list).
  let rendered = 0;
  let failed = 0;
  for (const bookmark of filtered) {
    try {
      container.appendChild(createBookmarkCard(bookmark));
      rendered++;
    } catch (err) {
      failed++;
      console.error('[X-Vault] Failed to render bookmark', bookmark?.tweetId, err, bookmark);
    }
  }
  console.log(`[X-Vault] Bookmarks: ${bookmarksCache.length} in store, ${filtered.length} after filter, ${rendered} rendered, ${failed} failed`);
}

function createBookmarkCard(tweet) {
  // Read-only grid card + a dedicated "remove bookmark" delete button
  const card = createGridCard(tweet, { selectable: false });
  const header = card.querySelector('.grid-card-header');
  if (header) {
    const del = document.createElement('button');
    del.className = 'grid-card-delete';
    del.title = 'Remove bookmark';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      await sendMessage({ type: 'DELETE_BOOKMARK', tweetId: tweet.tweetId });
      bookmarksCache = bookmarksCache.filter(b => b.tweetId !== tweet.tweetId);
      card.remove();
      updateBookmarkCount();
    });
    header.appendChild(del);
  }
  return card;
}

function scheduleBookmarkRefresh() {
  clearTimeout(bookmarkRefreshTimer);
  bookmarkRefreshTimer = setTimeout(loadBookmarksView, 800);
}

document.getElementById('sync-bookmarks-btn').addEventListener('click', () => {
  sendMessage({ type: 'SYNC_BOOKMARKS' });
  showToast('Opening your X bookmarks — keep that tab open while it grabs');
});

document.getElementById('refresh-bookmarks-btn').addEventListener('click', loadBookmarksView);

document.getElementById('bookmark-filter').addEventListener('input', (e) => {
  bookmarkFilter = e.target.value.trim();
  renderBookmarks();
});

document.getElementById('clear-bookmarks-btn').addEventListener('click', async () => {
  if (!confirm(`Remove all ${bookmarksCache.length} saved bookmarks? This does not affect X.`)) return;
  await sendMessage({ type: 'CLEAR_BOOKMARKS' });
  bookmarksCache = [];
  bookmarkFilter = '';
  document.getElementById('bookmark-filter').value = '';
  renderBookmarks();
  showToast('Bookmarks cleared');
});

async function loadCollectionsView() {
  const tags = await sendMessage({ type: 'GET_ALL_TAGS' });
  const sidebar = document.getElementById('tag-list');
  sidebar.innerHTML = '';

  if (!tags || tags.length === 0) {
    sidebar.innerHTML = '<div class="empty-state">No tags yet. Tag tweets from the Users view.</div>';
    return;
  }

  for (const { tag, count } of tags) {
    const item = document.createElement('div');
    item.className = 'tag-item';
    if (selectedTag === tag) item.classList.add('active');
    item.innerHTML = `<span class="tag-item-name">#${escapeHtml(tag)}</span><span class="count-badge">${count}</span>`;
    item.addEventListener('click', () => selectTag(tag));
    sidebar.appendChild(item);
  }

  // Auto-select first tag if none selected
  if (!selectedTag && tags.length > 0) {
    selectTag(tags[0].tag);
  } else if (selectedTag) {
    selectTag(selectedTag);
  }
}

async function selectTag(tag) {
  selectedTag = tag;
  document.querySelectorAll('.tag-item').forEach(el => {
    el.classList.toggle('active', el.querySelector('.tag-item-name').textContent === `#${tag}`);
  });

  const tweets = await sendMessage({ type: 'GET_TWEETS_BY_TAG', tag });
  const container = document.getElementById('collection-tweets');
  container.innerHTML = '';

  if (!tweets || tweets.length === 0) {
    container.innerHTML = '<div class="empty-state">No tweets with this tag.</div>';
    return;
  }

  for (const tweet of tweets) {
    container.appendChild(createGridCard(tweet, { selectable: false }));
  }
}

// ==================== Capture Stats Chart ====================

async function drawCaptureChart() {
  const canvas = document.getElementById('capture-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const stats = await sendMessage({ type: 'GET_CAPTURE_STATS' });
  if (!stats || stats.length === 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#657786';
    ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No capture data yet', canvas.width / 2, canvas.height / 2);
    return;
  }

  // Ensure canvas size matches CSS
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * (window.devicePixelRatio || 1);
  canvas.height = rect.height * (window.devicePixelRatio || 1);
  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

  const w = rect.width;
  const h = rect.height;
  const pad = { top: 20, right: 12, bottom: 28, left: 36 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;

  ctx.clearRect(0, 0, w * 2, h * 2);

  const maxCount = Math.max(...stats.map(s => s.count), 1);
  const barW = Math.max(4, Math.floor(chartW / stats.length) - 2);

  // Draw bars
  stats.forEach((s, i) => {
    const barH = (s.count / maxCount) * chartH;
    const x = pad.left + (i * (chartW / stats.length)) + 1;
    const y = pad.top + chartH - barH;

    // Gradient bar
    const grad = ctx.createLinearGradient(x, y, x, y + barH);
    grad.addColorStop(0, '#1DA1F2');
    grad.addColorStop(1, '#0d8bd9');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, 2);
    ctx.fill();
  });

  // X-axis labels (show a few dates)
  ctx.fillStyle = '#657786';
  ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  const labelStep = Math.max(1, Math.floor(stats.length / 5));
  stats.forEach((s, i) => {
    if (i % labelStep === 0 || i === stats.length - 1) {
      const x = pad.left + (i * (chartW / stats.length)) + barW / 2;
      const label = s.date.slice(5); // MM-DD
      ctx.fillText(label, x, h - 6);
    }
  });

  // Y-axis label
  ctx.textAlign = 'right';
  ctx.fillText(maxCount, pad.left - 4, pad.top + 8);
  ctx.fillText('0', pad.left - 4, pad.top + chartH);
}

// ==================== Auto-Backup Toggle ====================

document.getElementById('auto-backup-enabled').addEventListener('change', (e) => {
  document.getElementById('auto-backup-options').classList.toggle('hidden', !e.target.checked);
});

// ==================== Init ====================

async function reloadAll() {
  selectedUser = null;
  selectedUserData = null;
  hideUserContext();

  // Load initial view
  showView('home');
}

document.addEventListener('DOMContentLoaded', reloadAll);
