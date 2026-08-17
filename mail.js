const nodemailer = require('nodemailer');

const smtpConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let transporter = null;
if (smtpConfigured) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

// Отправляет код подтверждения. Если SMTP не настроен — просто печатает в консоль
// (удобно для разработки/первого запуска на Render без готовой почты).
async function sendVerificationCode(email, code) {
  if (!transporter) {
    console.log(`[mail:dev] Код подтверждения для ${email}: ${code}`);
    return;
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || 'Hush <no-reply@hush.app>',
    to: email,
    subject: 'Код подтверждения Hush',
    text: `Ваш код подтверждения: ${code}\n\nОн действителен 15 минут.`,
    html: `<p>Ваш код подтверждения:</p><h2 style="letter-spacing:4px">${code}</h2><p>Он действителен 15 минут.</p>`
  });
}

module.exports = { sendVerificationCode };
