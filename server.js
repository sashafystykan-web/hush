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

const { PendingUser, User, Post, Friendship, Announcement } = require('./models');
const { sendVerificationCode } = require('./mail');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const PORT = process.env.PORT || 3000;

// ---------- Подключение к БД ----------
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB подключена'))
  .catch(err => console.error('Ошибка подключения к MongoDB:', err.message));

// ---------- Приложение ----------
const app = express();
app.set('trust proxy', 1); // Render стоит за прокси — нужен реальный IP для антиспама
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
    hasAvatar: !!(user.avatar && user.avatar.data),
    isAdmin: !!user.isAdmin
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
      nickname: post.author.nickname,
      isAdmin: !!post.author.isAdmin
    } : null,
    score,
    myVote
  };
}

// =======================================================
// Антиспам: простой лимитер запросов в памяти процесса
// =======================================================
const rateBuckets = new Map();
function rateLimit({ windowMs, max, keyFn, message }) {
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      rateBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      const waitSec = Math.ceil((bucket.start + windowMs - now) / 1000);
      return res.status(429).json({ error: message || `Слишком часто, подождите ${waitSec} сек` });
    }
    next();
  };
}
// периодически чистим старые записи, чтобы карта не росла бесконечно
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.start > 60 * 60 * 1000) rateBuckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

// =======================================================
// Регистрация: шаг 1 — email + пароль -> код на почту
// =======================================================
app.post('/api/auth/register/start',
  rateLimit({ windowMs: 60 * 60 * 1000, max: 5, keyFn: req => 'regstart:' + req.ip, message: 'Слишком много попыток регистрации, попробуйте позже' }),
  async (req, res) => {
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
app.post('/api/auth/register/verify',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyFn: req => 'regverify:' + req.ip, message: 'Слишком много попыток, подождите' }),
  async (req, res) => {
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
app.post('/api/auth/login',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 15, keyFn: req => 'login:' + req.ip, message: 'Слишком много попыток входа, подождите' }),
  async (req, res) => {
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
// Текущий пользователь + настройки профиля
// =======================================================
app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json(publicUser(user));
});

// Обновить ник / био / аватар
app.patch('/api/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Не найден' });

    const { nickname, bio, avatarBase64, removeAvatar } = req.body;

    if (nickname !== undefined) {
      const trimmed = nickname.trim();
      if (!trimmed) return res.status(400).json({ error: 'Имя не может быть пустым' });
      user.nickname = trimmed.slice(0, 60);
    }
    if (bio !== undefined) {
      user.bio = String(bio).slice(0, 200);
    }
    if (avatarBase64) {
      user.avatar = { data: await compressAvatar(avatarBase64), contentType: 'image/webp' };
    } else if (removeAvatar) {
      user.avatar = undefined;
    }

    await user.save();
    res.json(publicUser(user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Сменить пароль
app.post('/api/me/password',
  authMiddleware,
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyFn: req => 'pwd:' + req.userId, message: 'Слишком много попыток, подождите' }),
  async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ error: 'Новый пароль должен быть от 6 символов' });
      }
      const user = await User.findById(req.userId);
      if (!user) return res.status(404).json({ error: 'Не найден' });

      const ok = await bcrypt.compare(currentPassword || '', user.passwordHash);
      if (!ok) return res.status(401).json({ error: 'Неверный текущий пароль' });

      user.passwordHash = await bcrypt.hash(newPassword, 10);
      await user.save();
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
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

// Профиль пользователя + статус дружбы относительно текущего юзера
app.get('/api/users/:username', authMiddleware, async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  let friendStatus = 'self';
  if (String(user._id) !== req.userId) {
    friendStatus = 'none';
    const rel = await Friendship.findOne({
      $or: [{ from: req.userId, to: user._id }, { from: user._id, to: req.userId }]
    });
    if (rel) {
      if (rel.status === 'accepted') friendStatus = 'friends';
      else friendStatus = String(rel.from) === req.userId ? 'outgoing' : 'incoming';
    }
  }

  res.json({ ...publicUser(user), friendStatus });
});

// Посты конкретного пользователя (для профиля)
app.get('/api/users/:username/posts', authMiddleware, async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const posts = await Post.find({ author: user._id })
    .populate('author', 'username nickname isAdmin')
    .sort({ createdAt: -1 })
    .limit(50);
  res.json(posts.map(p => publicPost(p, req.userId)));
});

// =======================================================
// Друзья
// =======================================================

// Список: друзья + входящие + исходящие заявки
app.get('/api/friends', authMiddleware, async (req, res) => {
  const rels = await Friendship.find({ $or: [{ from: req.userId }, { to: req.userId }] })
    .populate('from', 'username nickname isAdmin')
    .populate('to', 'username nickname isAdmin');

  const friends = [], incoming = [], outgoing = [];
  for (const r of rels) {
    if (!r.from || !r.to) continue; // на случай удалённого аккаунта
    const isMine = String(r.from._id) === req.userId;
    const other = isMine ? r.to : r.from;
    if (r.status === 'accepted') friends.push(publicUser(other));
    else if (isMine) outgoing.push(publicUser(other));
    else incoming.push(publicUser(other));
  }
  res.json({ friends, incoming, outgoing });
});

// Отправить заявку в друзья
app.post('/api/friends/request/:username', authMiddleware, async (req, res) => {
  try {
    const target = await User.findOne({ username: req.params.username });
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
    if (String(target._id) === req.userId) return res.status(400).json({ error: 'Нельзя добавить самого себя' });

    const existing = await Friendship.findOne({
      $or: [{ from: req.userId, to: target._id }, { from: target._id, to: req.userId }]
    });
    if (existing) {
      if (existing.status === 'accepted') return res.status(409).json({ error: 'Уже в друзьях' });
      if (String(existing.from) === req.userId) return res.status(409).json({ error: 'Заявка уже отправлена' });
      // у нас уже есть встречная заявка от этого человека — просто принимаем
      existing.status = 'accepted';
      await existing.save();
      return res.json({ ok: true, status: 'friends' });
    }

    await Friendship.create({ from: req.userId, to: target._id, status: 'pending' });
    res.json({ ok: true, status: 'outgoing' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Принять входящую заявку
app.post('/api/friends/accept/:username', authMiddleware, async (req, res) => {
  const target = await User.findOne({ username: req.params.username });
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
  const rel = await Friendship.findOne({ from: target._id, to: req.userId, status: 'pending' });
  if (!rel) return res.status(404).json({ error: 'Заявка не найдена' });
  rel.status = 'accepted';
  await rel.save();
  res.json({ ok: true, status: 'friends' });
});

// Отклонить заявку / отменить свою заявку / удалить из друзей — всё через удаление связи
app.delete('/api/friends/:username', authMiddleware, async (req, res) => {
  const target = await User.findOne({ username: req.params.username });
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
  await Friendship.deleteOne({
    $or: [{ from: req.userId, to: target._id }, { from: target._id, to: req.userId }]
  });
  res.json({ ok: true, status: 'none' });
});

// =======================================================
// Лента постов
// =======================================================

// Список постов: ?sort=new|top
app.get('/api/posts', authMiddleware, async (req, res) => {
  const posts = await Post.find({})
    .populate('author', 'username nickname isAdmin')
    .sort({ createdAt: -1 })
    .limit(100);

  let result = posts.map(p => publicPost(p, req.userId));
  if (req.query.sort === 'top') {
    result = result.sort((a, b) => b.score - a.score || new Date(b.createdAt) - new Date(a.createdAt));
  }
  res.json(result);
});

// Создать пост (антиспам: не чаще раза в 10 секунд на юзера)
app.post('/api/posts', authMiddleware, async (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Пустой пост' });
    if (text.length > 2000) return res.status(400).json({ error: 'Слишком длинный пост' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Не найден' });

    const POST_COOLDOWN_MS = 10 * 1000;
    if (user.lastPostAt && Date.now() - user.lastPostAt.getTime() < POST_COOLDOWN_MS) {
      const waitSec = Math.ceil((POST_COOLDOWN_MS - (Date.now() - user.lastPostAt.getTime())) / 1000);
      return res.status(429).json({ error: `Не так быстро, подождите ${waitSec} сек` });
    }

    const post = await Post.create({ author: req.userId, text });
    await post.populate('author', 'username nickname isAdmin');

    user.lastPostAt = new Date();
    await user.save();

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

// =======================================================
// Новости приложения (пишут только админы, видят все)
// =======================================================
app.get('/api/announcements', authMiddleware, async (req, res) => {
  const items = await Announcement.find({})
    .populate('author', 'username nickname isAdmin')
    .sort({ createdAt: -1 })
    .limit(30);
  res.json(items.map(a => ({
    id: a._id,
    text: a.text,
    createdAt: a.createdAt,
    author: a.author ? publicUser(a.author) : null
  })));
});

app.post('/api/announcements', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user || !user.isAdmin) return res.status(403).json({ error: 'Публиковать новости могут только админы' });

    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Пустая новость' });
    if (text.length > 1000) return res.status(400).json({ error: 'Слишком длинный текст' });

    const ann = await Announcement.create({ author: req.userId, text });
    await ann.populate('author', 'username nickname isAdmin');

    const payload = { id: ann._id, text: ann.text, createdAt: ann.createdAt, author: publicUser(ann.author) };
    io.emit('announcement:new', payload);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ---------- Отдаём index.html на все прочие GET (одностраничный клиент) ----------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =======================================================
// Socket.io — только для лайв-обновлений (посты, голоса, новости)
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
