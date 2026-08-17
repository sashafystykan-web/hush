// ============ Состояние ============
let token = localStorage.getItem('hush_token') || null;
let currentUser = null;
let currentChatId = null;
let setupToken = null; // временный токен между шагами регистрации
let regEmail = null;
let socket = null;
let regAvatarBase64 = null;

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

function chatAvatarUrl(chatId) {
  return `/api/avatar/chat/${chatId}`;
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
  document.getElementById('my-avatar').src = avatarUrl(user.id);
  connectSocket();
  loadChats();
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

// ============ Сокеты ============
function connectSocket() {
  socket = io({ auth: { token } });
  socket.on('message', (msg) => {
    if (String(msg.chat) === String(currentChatId)) {
      renderMessage(msg);
    }
    loadChats(); // обновить порядок/превью в списке
  });
}

// ============ Список чатов ============
async function loadChats() {
  const chats = await api('/chats');
  const listEl = document.getElementById('chat-list');
  listEl.innerHTML = '';
  chats.forEach(chat => {
    const item = document.createElement('div');
    item.className = 'list-item';
    const img = document.createElement('img');
    img.src = chatAvatarUrl(chat._id);
    img.onerror = () => { img.style.visibility = 'hidden'; };
    const label = document.createElement('span');
    label.textContent = chatDisplayName(chat);
    item.append(img, label);
    item.onclick = () => openChat(chat._id, chatDisplayName(chat));
    listEl.appendChild(item);
  });
}

function chatDisplayName(chat) {
  if (chat.type === 'direct') {
    const other = chat.members.find(m => m.user._id !== currentUser.id && m.user._id !== currentUser.id);
    const otherMember = chat.members.map(m => m.user).find(u => u._id !== currentUser.id);
    return otherMember ? (otherMember.nickname || otherMember.username) : 'Личный чат';
  }
  return chat.name || 'Без названия';
}

// ============ Открыть чат ============
async function openChat(chatId, displayName) {
  if (currentChatId) socket.emit('leave', currentChatId);
  currentChatId = chatId;
  socket.emit('join', chatId);

  document.getElementById('chat-header-name').textContent = displayName;
  document.getElementById('chat-header-avatar').src = chatAvatarUrl(chatId);
  show(document.getElementById('chat-header'));
  show(document.getElementById('message-form'));

  const messagesEl = document.getElementById('messages');
  messagesEl.innerHTML = '';
  const messages = await api(`/chats/${chatId}/messages`);
  messages.forEach(renderMessage);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessage(msg) {
  const messagesEl = document.getElementById('messages');
  const el = document.createElement('div');
  el.className = 'message' + (msg.sender._id === currentUser.id || msg.sender === currentUser.id ? ' mine' : '');
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = msg.sender.nickname || msg.sender.username || '';
  const text = document.createElement('span');
  text.textContent = msg.text;
  el.append(meta, text);
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

document.getElementById('message-form').onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById('message-input');
  if (!input.value.trim() || !currentChatId) return;
  socket.emit('message', { chatId: currentChatId, text: input.value });
  input.value = '';
};

// ============ Поиск людей ============
const searchInput = document.getElementById('search-input');
const searchResultsEl = document.getElementById('search-results');
const chatListEl = document.getElementById('chat-list');
let searchDebounce = null;

searchInput.oninput = () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  if (!q) {
    hide(searchResultsEl);
    show(chatListEl);
    return;
  }
  searchDebounce = setTimeout(async () => {
    const users = await api('/users/search?q=' + encodeURIComponent(q));
    searchResultsEl.innerHTML = '';
    users.forEach(u => {
      const item = document.createElement('div');
      item.className = 'list-item';
      const img = document.createElement('img');
      img.src = avatarUrl(u.id);
      img.onerror = () => { img.style.visibility = 'hidden'; };
      const label = document.createElement('span');
      label.textContent = u.nickname + ' (@' + u.username + ')';
      item.append(img, label);
      item.onclick = () => openProfile(u.username);
      searchResultsEl.appendChild(item);
    });
    hide(chatListEl);
    show(searchResultsEl);
  }, 300);
};

// ============ Профиль пользователя ============
const modalProfile = document.getElementById('modal-profile');

async function openProfile(username) {
  const user = await api('/users/' + username);
  document.getElementById('profile-avatar').src = avatarUrl(user.id);
  document.getElementById('profile-nickname').textContent = user.nickname;
  document.getElementById('profile-username').textContent = '@' + user.username;
  document.getElementById('profile-bio').textContent = user.bio || '';
  document.getElementById('profile-message-btn').onclick = async () => {
    if (user.username === currentUser.username) { closeProfile(); return; }
    const chat = await api('/chats', 'POST', { type: 'direct', memberUsernames: [user.username] });
    closeProfile();
    await loadChats();
    openChat(chat._id, user.nickname);
  };
  show(modalProfile);
}

function closeProfile() { hide(modalProfile); }

// ============ Новый чат / группа / канал ============
const modalNewChat = document.getElementById('modal-new-chat');
const newChatType = document.getElementById('new-chat-type');
const newChatName = document.getElementById('new-chat-name');

document.getElementById('new-chat-btn').onclick = () => show(modalNewChat);
function closeNewChat() { hide(modalNewChat); }

newChatType.onchange = () => {
  if (newChatType.value === 'direct') hide(newChatName);
  else show(newChatName);
};

document.getElementById('new-chat-create').onclick = async () => {
  const errEl = document.getElementById('new-chat-error');
  errEl.textContent = '';
  const type = newChatType.value;
  const members = document.getElementById('new-chat-members').value
    .split(',').map(s => s.trim()).filter(Boolean);
  try {
    const chat = await api('/chats', 'POST', { type, name: newChatName.value.trim(), memberUsernames: members });
    closeNewChat();
    await loadChats();
    openChat(chat._id, chatDisplayName({ ...chat, members: chat.members || [] }) || newChatName.value);
  } catch (err) {
    errEl.textContent = err.message;
  }
};
