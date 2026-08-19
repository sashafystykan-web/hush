// ============ Состояние ============
let token = localStorage.getItem('hush_token') || null;
let currentUser = null;
let setupToken = null; // временный токен между шагами регистрации
let regEmail = null;
let socket = null;
let regAvatarBase64 = null;
let currentSort = 'new';

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

// Создаёт новый div-аватар (для списков: лента, поиск)
function buildAvatar(user, extraClass) {
  const wrap = document.createElement('div');
  wrap.className = 'avatar' + (extraClass ? ' ' + extraClass : '');
  fillAvatar(wrap, user);
  return wrap;
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

  connectSocket();
  loadFeed();
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

// ============ Сокеты (лайв-обновления ленты) ============
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
}

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
  const nickname = document.createElement('span');
  nickname.className = 'nickname';
  nickname.textContent = post.author ? post.author.nickname : 'Удалён';
  const username = document.createElement('span');
  username.className = 'username';
  username.textContent = post.author ? '@' + post.author.username : '';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = timeAgo(post.createdAt);
  head.append(nickname, username, time);

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

// ============ Публикация поста ============
document.getElementById('compose-form').onsubmit = async (e) => {
  e.preventDefault();
  const textEl = document.getElementById('compose-text');
  const text = textEl.value.trim();
  if (!text) return;
  try {
    await api('/posts', 'POST', { text });
    textEl.value = '';
    // пост придёт через сокет всем, включая автора — не дублируем локально
  } catch (err) {
    alert(err.message);
  }
};

// ============ Поиск людей ============
const searchInput = document.getElementById('search-input');
const searchResultsEl = document.getElementById('search-results');
const feedPageEl = document.getElementById('feed-page');
let searchDebounce = null;

searchInput.oninput = () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  if (!q) {
    hide(searchResultsEl);
    show(feedPageEl);
    return;
  }
  searchDebounce = setTimeout(async () => {
    const users = await api('/users/search?q=' + encodeURIComponent(q));
    searchResultsEl.innerHTML = '';
    users.forEach(u => {
      const item = document.createElement('div');
      item.className = 'list-item';
      const avatar = buildAvatar(u);
      const label = document.createElement('span');
      label.textContent = u.nickname + ' (@' + u.username + ')';
      item.append(avatar, label);
      item.onclick = () => openProfile(u.username);
      searchResultsEl.appendChild(item);
    });
    hide(feedPageEl);
    show(searchResultsEl);
  }, 300);
};

// ============ Профиль пользователя ============
const modalProfile = document.getElementById('modal-profile');

async function openProfile(username) {
  const user = await api('/users/' + username);
  fillAvatar(document.getElementById('profile-avatar'), user);

  document.getElementById('profile-nickname').textContent = user.nickname;
  document.getElementById('profile-username').textContent = '@' + user.username;
  document.getElementById('profile-bio').textContent = user.bio || '';

  const postsEl = document.getElementById('profile-posts');
  postsEl.innerHTML = '';
  const posts = await api(`/users/${user.username}/posts`);
  posts.forEach(p => postsEl.appendChild(renderPost(p)));

  show(modalProfile);
}

function closeProfile() { hide(modalProfile); }
