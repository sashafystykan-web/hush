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

// Пост в ленте (как в Reddit): текст + голоса
const PostSchema = new Schema({
  author: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  text: { type: String, required: true, trim: true, maxlength: 2000 },
  votes: [{
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    value: { type: Number, enum: [1, -1] } // 1 = апвоут, -1 = даунвоут
  }],
  createdAt: { type: Date, default: Date.now, index: true }
});

module.exports = {
  PendingUser: mongoose.model('PendingUser', PendingUserSchema),
  User: mongoose.model('User', UserSchema),
  Post: mongoose.model('Post', PostSchema)
};
