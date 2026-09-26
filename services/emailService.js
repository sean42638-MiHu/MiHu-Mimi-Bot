const nodemailer = require('nodemailer');

function createEmailService({ env = process.env, createTransport = nodemailer.createTransport } = {}) {
    let transporter;

    function getTransporter() {
        const testAllowed = env.NODE_ENV === 'test' && env.SMTP_TEST_ENABLED === 'true';
        if (env.NODE_ENV === 'test' && !testAllowed) throw new Error('SMTP is disabled in tests');
        if (testAllowed && createTransport === nodemailer.createTransport) {
            throw new Error('Tests require an injected fake SMTP transport');
        }
        if (!testAllowed && env.SMTP_ENABLED !== 'true') throw new Error('SMTP is disabled');
        if (!testAllowed && (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS)) {
            throw new Error('SMTP configuration is incomplete');
        }
        if (!transporter) {
            transporter = createTransport({
                host: env.SMTP_HOST,
                port: Number(env.SMTP_PORT || 465),
                secure: env.SMTP_SECURE !== 'false',
                auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }
            });
        }
        return transporter;
    }

    return { sendVerificationCode };

    async function sendVerificationCode(toEmail, code) {
        return getTransporter().sendMail({
            from: `"米胡電競 MiHu Gaming" <${env.SMTP_USER}>`,
            to: toEmail,
            subject: '【米胡電競】電子郵件驗證碼',
            html: `
                <div style="background-color:#0b0914;color:#fff;padding:30px;font-family:sans-serif;border-radius:12px;max-width:480px;margin:0 auto;border:1px solid #9333ea">
                    <h2 style="color:#c084fc;text-align:center">🎮 米胡電競 會員驗證</h2>
                    <p>您好！我們收到了您在個人檔案綁定 Email 的請求。</p>
                    <p>請在驗證視窗中輸入以下 6 位數驗證碼（10 分鐘內有效）：</p>
                    <div style="text-align:center;margin:24px 0">
                        <span style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#fde047;background:#131021;padding:12px 24px;border-radius:8px;border:1px solid #a855f7">${code}</span>
                    </div>
                    <p style="font-size:12px;color:#94a3b8">如非本人操作，請忽略此郵件。</p>
                </div>
            `
        });
    }
}

const defaultEmailService = createEmailService();

module.exports = { sendVerificationCode: defaultEmailService.sendVerificationCode, createEmailService };