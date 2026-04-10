// 百万AI动画大师速成班 · 表单提交后端
// POST /api/apply  接收表单字段 -> 通过 SMTP 发送到 TO_EMAIL
// GET  /api/health 健康检查

require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// ---------- 简易内存限流：单 IP 每分钟最多 5 次 ----------
const RL_WINDOW = 60 * 1000;
const RL_MAX = 5;
const hits = new Map();

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function rateLimit(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RL_WINDOW);
  if (arr.length >= RL_MAX) {
    return res.status(429).json({ success: false, message: '请求过于频繁，请稍后再试' });
  }
  arr.push(now);
  hits.set(ip, arr);
  // 定期清理过期 key
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.length || now - v[v.length - 1] > RL_WINDOW) hits.delete(k);
    }
  }
  next();
}

// ---------- SMTP ----------
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.qq.com',
  port: Number(process.env.SMTP_PORT || 465),
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// 启动时验证一次 SMTP 连接，便于排错
transporter.verify().then(
  () => console.log('[smtp] ready'),
  (err) => console.error('[smtp] verify failed:', err.message)
);

// ---------- 工具 ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function pickStr(b, ...keys) {
  for (const k of keys) {
    const v = b[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

// ---------- 路由 ----------
app.post('/api/apply', rateLimit, async (req, res) => {
  try {
    const b = req.body || {};
    const name = pickStr(b, '姓名', 'name').slice(0, 60);
    const phone = pickStr(b, '联系方式', 'phone').slice(0, 60);
    const city = pickStr(b, '所在城市', 'city').slice(0, 60);
    const background = pickStr(b, '目前状态', 'background').slice(0, 60);
    const intro = pickStr(b, '补充说明', 'intro').slice(0, 1000);

    if (!name || !phone) {
      return res.status(400).json({ success: false, message: '请填写姓名和联系方式' });
    }

    const ip = getClientIp(req);
    const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    const rows = [
      ['姓名', name],
      ['联系方式', phone],
      ['所在城市', city || '未填写'],
      ['目前状态', background || '未填写'],
      ['补充说明', (intro || '未填写').replace(/\n/g, '<br>')],
      ['提交时间', ts],
      ['来源 IP', ip],
    ];

    const html = `
<div style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;max-width:640px;color:#08111f">
  <h2 style="margin:0 0 16px;font-size:20px;color:#08111f">百万AI动画大师速成班 · 新报名咨询</h2>
  <table style="width:100%;border-collapse:collapse;border:1px solid #e6eaf2;border-radius:8px;overflow:hidden">
    ${rows.map(([k, v]) => `
      <tr>
        <td style="padding:12px 14px;background:#f4f6fb;width:120px;font-weight:600;border-bottom:1px solid #e6eaf2;vertical-align:top">${escapeHtml(k)}</td>
        <td style="padding:12px 14px;border-bottom:1px solid #e6eaf2;color:#1f2a3d">${k === '补充说明' ? v : escapeHtml(v)}</td>
      </tr>
    `).join('')}
  </table>
  <p style="margin-top:16px;color:#9aa6bb;font-size:12px">本邮件由站点报名表单自动生成</p>
</div>`;

    await transporter.sendMail({
      from: `"百万AI动画速成班" <${process.env.SMTP_USER}>`,
      to: process.env.TO_EMAIL || process.env.SMTP_USER,
      subject: `【新报名】${name} - ${phone}`,
      html,
      replyTo: process.env.SMTP_USER,
    });

    res.json({ success: true, message: '提交成功' });
  } catch (err) {
    console.error('[apply] error:', err);
    res.status(500).json({ success: false, message: '服务异常，请稍后再试' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => {
  console.log(`[million-ai-api] listening on http://${host}:${port}`);
});
