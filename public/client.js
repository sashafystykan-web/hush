// ============ Состояние ============
let token = localStorage.getItem('hush_token') || null;
let currentUser = null;
let setupToken = null; // временный токен между шагами регистрации
let regEmail = null;
let socket = null;
let regAvatarBase64 = null;
let settingsAvatarBase64 = null;
let currentSort = 'new';
let currentPage = 'feed';
let postCooldownUntil = 0;

// ============ Утилиты ============
async function api(path, method = 'GET', body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch('/api' + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

function avatarUrl(userId) {
  return userId ? `/api/avatar/user/${userId}` : '';
}

// Заполняет переданный контейнер аватаркой: фото, если есть, иначе — первая буква ника
function fillAvatar(wrap, user) {
  wrap.innerHTML = '';
  const letter = (user.nickname || user.username || '?').trim().charAt(0).toUpperCase();
  if (!user.id) { wrap.textContent = letter; return; }
  const img = document.createElement('img');
  img.src = avatarUrl(user.id);
  img.onerror = () => { wrap.innerHTML = ''; wrap.textContent = letter; };
  wrap.appendChild(img);
}

// Создаёт новый div-аватар (для списков: лента, поиск, друзья)
function buildAvatar(user, extraClass) {
  const wrap = document.createElement('div');
  wrap.className = 'avatar' + (extraClass ? ' ' + extraClass : '');
  fillAvatar(wrap, user);
  return wrap;
}

// Ник + (если админ) голубой градиент и синяя галочка
function buildNickname(user, tag = 'span') {
  const el = document.createElement(tag);
  el.className = 'nickname' + (user.isAdmin ? ' admin' : '');
  el.textContent = user.nickname || user.username || '';
  if (user.isAdmin) {
    const badge = document.createElement('span');
    badge.className = 'badge-admin';
    badge.textContent = '✓';
    badge.title = 'Администратор';
    const holder = document.createElement('span');
    holder.style.display = 'inline-flex';
    holder.style.alignItems = 'center';
    holder.style.gap = '4px';
    holder.appendChild(el);
    holder.appendChild(badge);
    return holder;
  }
  return el;
}

function timeAgo(dateStr) {
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return 'только что';
  if (diff < 3600) return Math.floor(diff / 60) + ' мин назад';
  if (diff < 86400) return Math.floor(diff / 3600) + ' ч назад';
  return Math.floor(diff / 86400) + ' дн назад';
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

// ============ Тема ============
function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

(function initTheme() {
  const saved = localStorage.getItem('hush_theme') || 'dark';
  applyTheme(saved);
  document.getElementById('theme-toggle').checked = saved === 'dark';
})();

document.getElementById('theme-toggle').onchange = (e) => {
  const theme = e.target.checked ? 'dark' : 'light';
  localStorage.setItem('hush_theme', theme);
  applyTheme(theme);
};

// ============ Переключение вкладок логин/регистрация ============
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const formLogin = document.getElementById('form-login');
const formRegStart = document.getElementById('form-reg-start');
const formRegVerify = document.getElementById('form-reg-verify');
const formRegComplete = document.getElementById('form-reg-complete');

tabLogin.onclick = () => {
  tabLogin.classList.add('active');
  tabRegister.classList.remove('active');
  show(formLogin);
  [formRegStart, formRegVerify, formRegComplete].forEach(hide);
};

tabRegister.onclick = () => {
  tabRegister.classList.add('active');
  tabLogin.classList.remove('active');
  hide(formLogin);
  show(formRegStart);
  hide(formRegVerify);
  hide(formRegComplete);
};

// ============ Вход ============
formLogin.onsubmit = async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    const data = await api('/auth/login', 'POST', {
      emailOrUsername: document.getElementById('login-id').value.trim(),
      password: document.getElementById('login-password').value
    });
    onAuthSuccess(data.token, data.user);
  } catch (err) {
    errEl.textContent = err.message;
  }
};

// ============ Регистрация: шаг 1 ============
formRegStart.onsubmit = async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('reg-start-error');
  errEl.textContent = '';
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  try {
    await api('/auth/register/start', 'POST', { email, password });
    regEmail = email;
    hide(formRegStart);
    show(formRegVerify);
  } catch (err) {
    errEl.textContent = err.message;
  }
};

// ============ Регистрация: шаг 2 ============
formRegVerify.onsubmit = async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('reg-verify-error');
  errEl.textContent = '';
  try {
    const data = await api('/auth/register/verify', 'POST', {
      email: regEmail,
      code: document.getElementById('reg-code').value.trim()
    });
    setupToken = data.setupToken;
    hide(formRegVerify);
    show(formRegComplete);
  } catch (err) {
    errEl.textContent = err.message;
  }
};

// ============ Регистрация: шаг 3 — выбор аватара ============
const avatarInput = document.getElementById('reg-avatar');
const avatarPreview = document.getElementById('avatar-preview');
const avatarPlaceholder = document.getElementById('avatar-placeholder');

document.getElementById('avatar-picker').onclick = () => avatarInput.click();

avatarInput.onchange = () => {
  const file = avatarInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    regAvatarBase64 = reader.result; // dataURL, сервер сам обрежет base64,-часть
    avatarPreview.src = reader.result;
    avatarPreview.style.display = 'block';
    avatarPlaceholder.style.display = 'none';
  };
  reader.readAsDataURL(file);
};

formRegComplete.onsubmit = async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('reg-complete-error');
  errEl.textContent = '';
  try {
    const data = await api('/auth/register/complete', 'POST', {
      setupToken,
      nickname: document.getElementById('reg-nickname').value.trim(),
      username: document.getElementById('reg-username').value.trim(),
      avatarBase64: regAvatarBase64
    });
    onAuthSuccess(data.token, data.user);
  } catch (err) {
    errEl.textContent = err.message;
  }
};

// ============ Успешная авторизация ============
function onAuthSuccess(newToken, user) {
  token = newToken;
  currentUser = user;
  localStorage.setItem('hush_token', token);
  hide(document.getElementById('screen-auth'));
  show(document.getElementById('screen-app'));

  fillAvatar(document.getElementById('my-avatar'), user);
  document.getElementById('my-avatar').onclick = () => openProfile(currentUser.username);

  if (user.isAdmin) show(document.getElementById('announce-form'));

  connectSocket();
  loadFeed();
  loadAnnouncements();
}

// Попытка авто-входа по сохранённому токену
(async function tryAutoLogin() {
  if (!token) return;
  try {
    const user = await api('/me');
    onAuthSuccess(token, user);
  } catch {
    localStorage.removeItem('hush_token');
    token = null;
  }
})();

// ============ Сокеты (лайв-обновления) ============
function connectSocket() {
  socket = io({ auth: { token } });

  socket.on('post:new', (post) => {
    if (currentSort === 'new') prependPost(post);
  });

  socket.on('post:vote', ({ id, score }) => {
    const el = document.querySelector(`.post[data-id="${id}"] .post-score`);
    if (el) el.textContent = score;
  });

  socket.on('post:delete', ({ id }) => {
    const el = document.querySelector(`.post[data-id="${id}"]`);
    if (el) el.remove();
  });

  socket.on('announcement:new', (ann) => {
    prependAnnouncement(ann);
  });
}

// ============ Вкладки Лента / Друзья ============
document.querySelectorAll('.main-tab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.main-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentPage = btn.dataset.page;
    document.getElementById('feed-page').classList.toggle('hidden', currentPage !== 'feed');
    document.getElementById('friends-page').classList.toggle('hidden', currentPage !== 'friends');
    if (currentPage === 'friends') loadFriends();
  };
});

// ============ Лента ============
const feedEl = document.getElementById('feed');

async function loadFeed() {
  const posts = await api('/posts?sort=' + currentSort);
  feedEl.innerHTML = '';
  posts.forEach(p => feedEl.appendChild(renderPost(p)));
}

document.querySelectorAll('.sort-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSort = btn.dataset.sort;
    loadFeed();
  };
});

function prependPost(post) {
  feedEl.insertBefore(renderPost(post), feedEl.firstChild);
}

function renderPost(post) {
  const el = document.createElement('div');
  el.className = 'post';
  el.dataset.id = post.id;

  const avatar = buildAvatar(post.author || { nickname: '?' });

  const body = document.createElement('div');
  body.className = 'post-body';

  const head = document.createElement('div');
  head.className = 'post-head';
  head.appendChild(buildNickname(post.author || { nickname: 'Удалён' }));
  const username = document.createElement('span');
  username.className = 'username';
  username.textContent = post.author ? '@' + post.author.username : '';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = timeAgo(post.createdAt);
  head.append(username, time);

  const text = document.createElement('div');
  text.className = 'post-text';
  text.textContent = post.text;

  const footer = document.createElement('div');
  footer.className = 'post-footer';

  const upBtn = document.createElement('button');
  upBtn.className = 'vote-btn' + (post.myVote === 1 ? ' active' : '');
  upBtn.textContent = '▲';

  const scoreEl = document.createElement('span');
  scoreEl.className = 'post-score';
  scoreEl.textContent = post.score;

  const downBtn = document.createElement('button');
  downBtn.className = 'vote-btn' + (post.myVote === -1 ? ' active' : '');
  downBtn.textContent = '▼';

  let myVote = post.myVote;
  async function vote(value) {
    const newValue = myVote === value ? 0 : value;
    try {
      const data = await api(`/posts/${post.id}/vote`, 'POST', { value: newValue });
      myVote = data.myVote;
      scoreEl.textContent = data.score;
      upBtn.classList.toggle('active', myVote === 1);
      downBtn.classList.toggle('active', myVote === -1);
    } catch (err) {
      alert(err.message);
    }
  }
  upBtn.onclick = () => vote(1);
  downBtn.onclick = () => vote(-1);

  footer.append(upBtn, scoreEl, downBtn);

  if (post.author && currentUser && post.author.id === currentUser.id) {
    const delBtn = document.createElement('span');
    delBtn.className = 'post-delete';
    delBtn.textContent = 'Удалить';
    delBtn.onclick = async () => {
      if (!confirm('Удалить пост?')) return;
      try {
        await api(`/posts/${post.id}`, 'DELETE');
        el.remove();
      } catch (err) {
        alert(err.message);
      }
    };
    footer.appendChild(delBtn);
  }

  body.append(head, text, footer);
  el.append(avatar, body);
  return el;
}

// ============ Публикация поста (с антиспам-кулдауном на клиенте) ============
const composeForm = document.getElementById('compose-form');
const composeBtn = composeForm.querySelector('button');

composeForm.onsubmit = async (e) => {
  e.preventDefault();
  const textEl = document.getElementById('compose-text');
  const text = textEl.value.trim();
  if (!text) return;

  composeBtn.disabled = true;
  try {
    await api('/posts', 'POST', { text });
    textEl.value = '';
    // пост придёт через сокет всем, включая автора — не дублируем локально
    postCooldownUntil = Date.now() + 10000;
    startCooldownCountdown();
  } catch (err) {
    alert(err.message);
    composeBtn.disabled = false;
  }
};

function startCooldownCountdown() {
  const tick = () => {
    const left = Math.ceil((postCooldownUntil - Date.now()) / 1000);
    if (left <= 0) {
      composeBtn.disabled = false;
      composeBtn.textContent = 'Запостить';
      return;
    }
    composeBtn.textContent = `Подождите ${left}с`;
    setTimeout(tick, 500);
  };
  tick();
}

// ============ Новости приложения ============
const newsListEl = document.getElementById('news-list');

async function loadAnnouncements() {
  const items = await api('/announcements');
  newsListEl.innerHTML = '';
  items.forEach(a => newsListEl.appendChild(renderAnnouncement(a)));
}

function prependAnnouncement(a) {
  newsListEl.insertBefore(renderAnnouncement(a), newsListEl.firstChild);
}

function renderAnnouncement(a) {
  const el = document.createElement('div');
  el.className = 'news-item';

  const head = document.createElement('div');
  head.className = 'news-item-head';
  head.appendChild(buildNickname(a.author || { nickname: 'Hush' }));
  head.appendChild(document.createTextNode('')); // разделитель не нужен, gap решает

  const text = document.createElement('div');
  text.className = 'news-item-text';
  text.textContent = a.text;

  const time = document.createElement('div');
  time.className = 'news-item-time';
  time.textContent = timeAgo(a.createdAt);

  el.append(head, text, time);
  return el;
}

document.getElementById('announce-form').onsubmit = async (e) => {
  e.preventDefault();
  const textEl = document.getElementById('announce-text');
  const text = textEl.value.trim();
  if (!text) return;
  try {
    await api('/announcements', 'POST', { text });
    textEl.value = '';
  } catch (err) {
    alert(err.message);
  }
};

// ============ Друзья ============
async function loadFriends() {
  const { friends, incoming, outgoing } = await api('/friends');

  const incomingEl = document.getElementById('friends-incoming');
  const outgoingEl = document.getElementById('friends-outgoing');
  const listEl = document.getElementById('friends-list');
  incomingEl.innerHTML = '';
  outgoingEl.innerHTML = '';
  listEl.innerHTML = '';

  document.getElementById('incoming-title').classList.toggle('hidden', incoming.length === 0);
  document.getElementById('outgoing-title').classList.toggle('hidden', outgoing.length === 0);
  document.getElementById('friends-empty').classList.toggle('hidden', friends.length !== 0);

  incoming.forEach(u => incomingEl.appendChild(renderFriendRow(u, 'incoming')));
  outgoing.forEach(u => outgoingEl.appendChild(renderFriendRow(u, 'outgoing')));
  friends.forEach(u => listEl.appendChild(renderFriendRow(u, 'friends')));
}

function renderFriendRow(user, status) {
  const item = document.createElement('div');
  item.className = 'list-item';

  const avatar = buildAvatar(user);
  const info = document.createElement('div');
  info.className = 'list-item-info';
  const nameRow = document.createElement('div');
  nameRow.className = 'list-item-name';
  nameRow.appendChild(buildNickname(user));
  const usernameEl = document.createElement('span');
  usernameEl.className = 'list-item-username';
  usernameEl.textContent = '@' + user.username;
  info.append(nameRow, usernameEl);

  info.onclick = () => openProfile(user.username);
  avatar.onclick = () => openProfile(user.username);

  item.append(avatar, info);

  if (status === 'incoming') {
    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'list-item-action primary';
    acceptBtn.textContent = 'Принять';
    acceptBtn.onclick = async () => {
      await api(`/friends/accept/${user.username}`, 'POST');
      loadFriends();
    };
    const declineBtn = document.createElement('button');
    declineBtn.className = 'list-item-action danger';
    declineBtn.textContent = 'Отклонить';
    declineBtn.onclick = async () => {
      await api(`/friends/${user.username}`, 'DELETE');
      loadFriends();
    };
    item.append(acceptBtn, declineBtn);
  } else if (status === 'outgoing') {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'list-item-action';
    cancelBtn.textContent = 'Отменить';
    cancelBtn.onclick = async () => {
      await api(`/friends/${user.username}`, 'DELETE');
      loadFriends();
    };
    item.append(cancelBtn);
  } else {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'list-item-action danger';
    removeBtn.textContent = 'Удалить';
    removeBtn.onclick = async () => {
      if (!confirm('Удалить из друзей?')) return;
      await api(`/friends/${user.username}`, 'DELETE');
      loadFriends();
    };
    item.append(removeBtn);
  }

  return item;
}

// ============ Поиск людей ============
const searchInput = document.getElementById('search-input');
const searchResultsEl = document.getElementById('search-results');
const appLayoutEl = document.getElementById('app-layout');
let searchDebounce = null;

searchInput.oninput = () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  if (!q) {
    hide(searchResultsEl);
    show(appLayoutEl);
    return;
  }
  searchDebounce = setTimeout(async () => {
    const users = await api('/users/search?q=' + encodeURIComponent(q));
    searchResultsEl.innerHTML = '';
    users.forEach(u => {
      const item = document.createElement('div');
      item.className = 'list-item';
      const avatar = buildAvatar(u);
      const info = document.createElement('div');
      info.className = 'list-item-info';
      const nameRow = document.createElement('div');
      nameRow.className = 'list-item-name';
      nameRow.appendChild(buildNickname(u));
      const usernameEl = document.createElement('span');
      usernameEl.className = 'list-item-username';
      usernameEl.textContent = '@' + u.username;
      info.append(nameRow, usernameEl);
      item.append(avatar, info);
      item.onclick = () => openProfile(u.username);
      searchResultsEl.appendChild(item);
    });
    hide(appLayoutEl);
    show(searchResultsEl);
  }, 300);
};

// ============ Профиль пользователя ============
const modalProfile = document.getElementById('modal-profile');

async function openProfile(username) {
  const user = await api('/users/' + username);
  fillAvatar(document.getElementById('profile-avatar'), user);

  const nicknameEl = document.getElementById('profile-nickname');
  nicknameEl.innerHTML = '';
  nicknameEl.className = '';
  nicknameEl.appendChild(buildNickname(user, 'span'));

  document.getElementById('profile-username').textContent = '@' + user.username;
  document.getElementById('profile-bio').textContent = user.bio || '';

  setupFriendButton(user);

  const postsEl = document.getElementById('profile-posts');
  postsEl.innerHTML = '';
  const posts = await api(`/users/${user.username}/posts`);
  posts.forEach(p => postsEl.appendChild(renderPost(p)));

  show(modalProfile);
}

function setupFriendButton(user) {
  const btn = document.getElementById('profile-friend-btn');
  btn.className = '';
  btn.onclick = null;

  if (user.friendStatus === 'self') {
    hide(btn);
    return;
  }
  show(btn);

  if (user.friendStatus === 'none') {
    btn.textContent = 'Добавить в друзья';
    btn.onclick = async () => {
      try {
        await api(`/friends/request/${user.username}`, 'POST');
        user.friendStatus = 'outgoing';
        setupFriendButton(user);
      } catch (err) { alert(err.message); }
    };
  } else if (user.friendStatus === 'outgoing') {
    btn.className = 'secondary';
    btn.textContent = 'Заявка отправлена — отменить';
    btn.onclick = async () => {
      await api(`/friends/${user.username}`, 'DELETE');
      user.friendStatus = 'none';
      setupFriendButton(user);
    };
  } else if (user.friendStatus === 'incoming') {
    btn.textContent = 'Принять заявку в друзья';
    btn.onclick = async () => {
      await api(`/friends/accept/${user.username}`, 'POST');
      user.friendStatus = 'friends';
      setupFriendButton(user);
    };
  } else if (user.friendStatus === 'friends') {
    btn.className = 'danger';
    btn.textContent = 'В друзьях — удалить';
    btn.onclick = async () => {
      if (!confirm('Удалить из друзей?')) return;
      await api(`/friends/${user.username}`, 'DELETE');
      user.friendStatus = 'none';
      setupFriendButton(user);
    };
  }
}

function closeProfile() { hide(modalProfile); }

// ============ Настройки ============
const modalSettings = document.getElementById('modal-settings');

document.getElementById('settings-btn').onclick = () => {
  document.getElementById('settings-nickname').value = currentUser.nickname;
  document.getElementById('settings-bio').value = currentUser.bio || '';
  settingsAvatarBase64 = null;
  fillAvatar(document.getElementById('settings-avatar'), currentUser);
  hide(document.getElementById('settings-profile-success'));
  hide(document.getElementById('settings-password-success'));
  document.getElementById('settings-profile-error').textContent = '';
  document.getElementById('settings-password-error').textContent = '';
  show(modalSettings);
};

function closeSettings() { hide(modalSettings); }

const settingsAvatarInput = document.getElementById('settings-avatar-input');
document.getElementById('settings-avatar-picker').onclick = () => settingsAvatarInput.click();

settingsAvatarInput.onchange = () => {
  const file = settingsAvatarInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    settingsAvatarBase64 = reader.result;
    const preview = document.getElementById('settings-avatar');
    preview.innerHTML = '';
    const img = document.createElement('img');
    img.src = reader.result;
    preview.appendChild(img);
  };
  reader.readAsDataURL(file);
};

document.getElementById('settings-profile-form').onsubmit = async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('settings-profile-error');
  const okEl = document.getElementById('settings-profile-success');
  errEl.textContent = '';
  hide(okEl);
  try {
    const payload = {
      nickname: document.getElementById('settings-nickname').value.trim(),
      bio: document.getElementById('settings-bio').value.trim()
    };
    if (settingsAvatarBase64) payload.avatarBase64 = settingsAvatarBase64;

    const updated = await api('/me', 'PATCH', payload);
    currentUser = updated;
    fillAvatar(document.getElementById('my-avatar'), currentUser);
    show(okEl);
  } catch (err) {
    errEl.textContent = err.message;
  }
};

document.getElementById('settings-password-form').onsubmit = async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('settings-password-error');
  const okEl = document.getElementById('settings-password-success');
  errEl.textContent = '';
  hide(okEl);
  try {
    await api('/me/password', 'POST', {
      currentPassword: document.getElementById('settings-current-password').value,
      newPassword: document.getElementById('settings-new-password').value
    });
    e.target.reset();
    show(okEl);
  } catch (err) {
    errEl.textContent = err.message;
  }
};

// ============ Выход из аккаунта ============
document.getElementById('logout-btn').onclick = () => {
  if (!confirm('Выйти из аккаунта?')) return;
  localStorage.removeItem('hush_token');
  if (socket) socket.disconnect();
  location.reload();
};
