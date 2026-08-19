require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const sharp = require('sharp');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const { PendingUser, User, Post } = require('./models');
const { sendVerificationCode } = require('./mail');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const PORT = process.env.PORT || 3000;

// ---------- Подключение к БД ----------
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB подключена'))
  .catch(err => console.error('Ошибка подключения к MongoDB:', err.message));

// ---------- Приложение ----------
const app = express();
app.use(express.json({ limit: '10mb' })); // аватар в base64 может весить прилично до сжатия
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CLIENT_ORIGIN || '*' }
});

// ---------- Вспомогательное ----------
function signToken(payload, expiresIn) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try {
    req.userId = jwt.verify(token, JWT_SECRET).uid;
    next();
  } catch {
    return res.status(401).json({ error: 'Невалидный токен' });
  }
}

// Сжимает картинку (base64 dataURL или чистый base64) под аватар: 256x256, webp
async function compressAvatar(base64Input) {
  const base64 = base64Input.includes(',') ? base64Input.split(',')[1] : base64Input;
  const inputBuffer = Buffer.from(base64, 'base64');
  const outputBuffer = await sharp(inputBuffer)
    .rotate() // учитывает EXIF-ориентацию перед тем как её стереть
    .resize(256, 256, { fit: 'cover' })
    .webp({ quality: 75 })
    .toBuffer();
  return outputBuffer;
}

function publicUser(user) {
  return {
    id: user._id,
    username: user.username,
    nickname: user.nickname,
    bio: user.bio,
    hasAvatar: !!(user.avatar && user.avatar.data)
  };
}

// Приводит пост к виду для отдачи клиенту: считает счёт голосов и голос текущего юзера
function publicPost(post, viewerId) {
  const score = post.votes.reduce((sum, v) => sum + v.value, 0);
  const myVote = viewerId ? (post.votes.find(v => String(v.user) === String(viewerId))?.value || 0) : 0;
  return {
    id: post._id,
    text: post.text,
    createdAt: post.createdAt,
    author: post.author ? {
      id: post.author._id,
      username: post.author.username,
      nickname: post.author.nickname
    } : null,
    score,
    myVote
  };
}

// =======================================================
// Регистрация: шаг 1 — email + пароль -> код на почту
// =======================================================
app.post('/api/auth/register/start', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password || password.length < 6) {
      return res.status(400).json({ error: 'Укажите email и пароль (минимум 6 символов)' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: 'Этот email уже зарегистрирован' });

    const code = String(crypto.randomInt(100000, 999999));
    const passwordHash = await bcrypt.hash(password, 10);

    await PendingUser.findOneAndUpdate(
      { email: email.toLowerCase() },
      { email: email.toLowerCase(), passwordHash, code, codeExpires: new Date(Date.now() + 15 * 60 * 1000), verified: false, createdAt: new Date() },
      { upsert: true }
    );

    await sendVerificationCode(email, code);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// =======================================================
// Регистрация: шаг 2 — проверка кода
// =======================================================
app.post('/api/auth/register/verify', async (req, res) => {
  try {
    const { email, code } = req.body;
    const pending = await PendingUser.findOne({ email: (email || '').toLowerCase() });
    if (!pending) return res.status(404).json({ error: 'Сначала начните регистрацию' });
    if (pending.codeExpires < new Date()) return res.status(400).json({ error: 'Код истёк, запросите новый' });
    if (pending.code !== String(code)) return res.status(400).json({ error: 'Неверный код' });

    pending.verified = true;
    await pending.save();

    // короткоживущий токен для финального шага регистрации
    const setupToken = signToken({ email: pending.email, purpose: 'setup' }, '30m');
    res.json({ ok: true, setupToken });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// =======================================================
// Регистрация: шаг 3 — юзернейм, ник, аватар -> создание User
// =======================================================
app.post('/api/auth/register/complete', async (req, res) => {
  try {
    const { setupToken, username, nickname, avatarBase64 } = req.body;

    let decoded;
    try {
      decoded = jwt.verify(setupToken, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Сессия регистрации истекла, начните заново' });
    }
    if (decoded.purpose !== 'setup') return res.status(401).json({ error: 'Невалидный токен' });

    const pending = await PendingUser.findOne({ email: decoded.email, verified: true });
    if (!pending) return res.status(400).json({ error: 'Email не подтверждён' });

    if (!username || username.length < 4) {
      return res.status(400).json({ error: 'Юзернейм должен быть от 4 символов' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: 'Юзернейм: только латиница, цифры и _' });
    }
    const usernameTaken = await User.findOne({ username });
    if (usernameTaken) return res.status(409).json({ error: 'Юзернейм уже занят' });

    const userDoc = new User({
      email: pending.email,
      passwordHash: pending.passwordHash,
      username,
      nickname: nickname || username,
    });

    if (avatarBase64) {
      const compressed = await compressAvatar(avatarBase64);
      userDoc.avatar = { data: compressed, contentType: 'image/webp' };
    }

    await userDoc.save();
    await PendingUser.deleteOne({ _id: pending._id });

    const token = signToken({ uid: userDoc._id }, '30d');
    res.json({ ok: true, token, user: publicUser(userDoc) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// =======================================================
// Вход
// =======================================================
app.post('/api/auth/login', async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body;
    const user = await User.findOne({
      $or: [{ email: (emailOrUsername || '').toLowerCase() }, { username: emailOrUsername }]
    });
    if (!user) return res.status(401).json({ error: 'Неверные данные' });

    const ok = await bcrypt.compare(password || '', user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Неверные данные' });

    const token = signToken({ uid: user._id }, '30d');
    res.json({ ok: true, token, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// =======================================================
// Текущий пользователь
// =======================================================
app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json(publicUser(user));
});

// =======================================================
// Аватар пользователя (отдаём бинарник)
// =======================================================
app.get('/api/avatar/user/:id', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user || !user.avatar || !user.avatar.data) return res.status(404).end();
  res.set('Content-Type', user.avatar.contentType);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(user.avatar.data);
});

// =======================================================
// Поиск людей + открытие профиля
// =======================================================
app.get('/api/users/search', authMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const users = await User.find({
    $or: [
      { username: { $regex: q, $options: 'i' } },
      { nickname: { $regex: q, $options: 'i' } }
    ]
  }).limit(20);
  res.json(users.map(publicUser));
});

app.get('/api/users/:username', authMiddleware, async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json(publicUser(user));
});

// Посты конкретного пользователя (для профиля)
app.get('/api/users/:username/posts', authMiddleware, async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const posts = await Post.find({ author: user._id })
    .populate('author', 'username nickname')
    .sort({ createdAt: -1 })
    .limit(50);
  res.json(posts.map(p => publicPost(p, req.userId)));
});

// =======================================================
// Лента постов
// =======================================================

// Список постов: ?sort=new|top
app.get('/api/posts', authMiddleware, async (req, res) => {
  const posts = await Post.find({})
    .populate('author', 'username nickname')
    .sort({ createdAt: -1 })
    .limit(100);

  let result = posts.map(p => publicPost(p, req.userId));
  if (req.query.sort === 'top') {
    result = result.sort((a, b) => b.score - a.score || new Date(b.createdAt) - new Date(a.createdAt));
  }
  res.json(result);
});

// Создать пост
app.post('/api/posts', authMiddleware, async (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Пустой пост' });
    if (text.length > 2000) return res.status(400).json({ error: 'Слишком длинный пост' });

    const post = await Post.create({ author: req.userId, text });
    await post.populate('author', 'username nickname');

    const payload = publicPost(post, null);
    io.emit('post:new', payload);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить свой пост
app.delete('/api/posts/:id', authMiddleware, async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  if (String(post.author) !== req.userId) return res.status(403).json({ error: 'Нет доступа' });

  await Post.deleteOne({ _id: post._id });
  io.emit('post:delete', { id: post._id });
  res.json({ ok: true });
});

// Голосование: value = 1 (апвоут), -1 (даунвоут) или 0 (снять голос)
app.post('/api/posts/:id/vote', authMiddleware, async (req, res) => {
  const value = Number(req.body.value);
  if (![1, -1, 0].includes(value)) return res.status(400).json({ error: 'Неверный голос' });

  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });

  post.votes = post.votes.filter(v => String(v.user) !== req.userId);
  if (value !== 0) post.votes.push({ user: req.userId, value });
  await post.save();

  const score = post.votes.reduce((sum, v) => sum + v.value, 0);
  io.emit('post:vote', { id: post._id, score });
  res.json({ score, myVote: value });
});

// ---------- Отдаём index.html на все прочие GET (одностраничный клиент) ----------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =======================================================
// Socket.io — только для лайв-обновлений ленты
// =======================================================
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

server.listen(PORT, () => console.log(`Hush запущен на порту ${PORT}`));
