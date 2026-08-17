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

const { PendingUser, User, Chat, Message } = require('./models');
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
// Аватар пользователя / чата (отдаём бинарник)
// =======================================================
app.get('/api/avatar/user/:id', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user || !user.avatar || !user.avatar.data) return res.status(404).end();
  res.set('Content-Type', user.avatar.contentType);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(user.avatar.data);
});

app.get('/api/avatar/chat/:id', async (req, res) => {
  const chat = await Chat.findById(req.params.id);
  if (!chat || !chat.avatar || !chat.avatar.data) return res.status(404).end();
  res.set('Content-Type', chat.avatar.contentType);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(chat.avatar.data);
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

// =======================================================
// Чаты и каналы
// =======================================================

// Создать личный чат / группу / канал
app.post('/api/chats', authMiddleware, async (req, res) => {
  try {
    const { type, memberUsernames, name } = req.body;
    if (!['direct', 'group', 'channel'].includes(type)) {
      return res.status(400).json({ error: 'Неверный тип чата' });
    }

    const members = await User.find({ username: { $in: memberUsernames || [] } });

    if (type === 'direct') {
      if (members.length !== 1) return res.status(400).json({ error: 'Для личного чата нужен ровно один собеседник' });
      // не создаём дубликат личного чата
      const existing = await Chat.findOne({
        type: 'direct',
        'members.user': { $all: [req.userId, members[0]._id] }
      });
      if (existing) return res.json(existing);

      const chat = await Chat.create({
        type: 'direct',
        members: [{ user: req.userId, role: 'member' }, { user: members[0]._id, role: 'member' }]
      });
      return res.json(chat);
    }

    // group или channel
    if (!name) return res.status(400).json({ error: 'Укажите название' });
    const chat = await Chat.create({
      type,
      name,
      owner: req.userId,
      members: [
        { user: req.userId, role: 'owner' },
        ...members.map(m => ({ user: m._id, role: 'member' }))
      ]
    });
    res.json(chat);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Список моих чатов
app.get('/api/chats', authMiddleware, async (req, res) => {
  const chats = await Chat.find({ 'members.user': req.userId })
    .populate('members.user', 'username nickname')
    .sort({ lastMessageAt: -1 });
  res.json(chats);
});

// История сообщений чата
app.get('/api/chats/:id/messages', authMiddleware, async (req, res) => {
  const chat = await Chat.findById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  const isMember = chat.members.some(m => String(m.user) === req.userId);
  if (!isMember) return res.status(403).json({ error: 'Нет доступа' });

  const messages = await Message.find({ chat: chat._id })
    .populate('sender', 'username nickname')
    .sort({ createdAt: 1 })
    .limit(200);
  res.json(messages);
});

// ---------- Отдаём index.html на все прочие GET (одностраничный клиент) ----------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =======================================================
// Socket.io — реальное время
// =======================================================
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.uid;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.on('join', (chatId) => {
    socket.join(String(chatId));
  });

  socket.on('leave', (chatId) => {
    socket.leave(String(chatId));
  });

  socket.on('message', async ({ chatId, text }) => {
    if (!text || !text.trim()) return;
    try {
      const chat = await Chat.findById(chatId);
      if (!chat) return;
      const isMember = chat.members.some(m => String(m.user) === socket.userId);
      if (!isMember) return;

      const message = await Message.create({ chat: chatId, sender: socket.userId, text: text.trim() });
      chat.lastMessageAt = new Date();
      await chat.save();

      const populated = await message.populate('sender', 'username nickname');
      io.to(String(chatId)).emit('message', populated);
    } catch (err) {
      console.error('socket message error:', err.message);
    }
  });
});

server.listen(PORT, () => console.log(`Hush запущен на порту ${PORT}`));
