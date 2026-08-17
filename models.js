const mongoose = require('mongoose');
const { Schema } = mongoose;

// Временная запись, пока пользователь не подтвердил email кодом
const PendingUserSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  code: { type: String, required: true },
  codeExpires: { type: Date, required: true },
  verified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 } // авточистка через 24ч
});

const UserSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  username: { type: String, required: true, unique: true, minlength: 4, trim: true },
  nickname: { type: String, required: true, trim: true },
  avatar: {
    data: Buffer,
    contentType: { type: String, default: 'image/webp' }
  },
  bio: { type: String, default: '', maxlength: 200 },
  createdAt: { type: Date, default: Date.now }
});

const ChatSchema = new Schema({
  type: { type: String, enum: ['direct', 'group', 'channel'], required: true },
  name: { type: String, trim: true }, // для group/channel
  avatar: {
    data: Buffer,
    contentType: { type: String, default: 'image/webp' }
  },
  owner: { type: Schema.Types.ObjectId, ref: 'User' }, // для group/channel
  members: [{
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    role: { type: String, enum: ['owner', 'admin', 'member'], default: 'member' }
  }],
  lastMessageAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

const MessageSchema = new Schema({
  chat: { type: Schema.Types.ObjectId, ref: 'Chat', required: true, index: true },
  sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true, trim: true, maxlength: 4000 },
  createdAt: { type: Date, default: Date.now }
});

module.exports = {
  PendingUser: mongoose.model('PendingUser', PendingUserSchema),
  User: mongoose.model('User', UserSchema),
  Chat: mongoose.model('Chat', ChatSchema),
  Message: mongoose.model('Message', MessageSchema)
};
