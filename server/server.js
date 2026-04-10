// 百万AI动画大师速成班 · 表单提交后端
// POST /api/apply  接收表单字段 -> 通过 SMTP 发送到 TO_EMAIL
// GET  /api/health 健康检查

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const nodemailer = require('nodemailer');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// 是否处于本地开发模式：无 SMTP 凭证时自动启用 mock，并在需要时托管静态文件
const SMTP_READY = Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
const SERVE_STATIC = process.env.SERVE_STATIC === '1';

// 提交记录本地落盘：每条提交先写一行 JSONL，再尝试发邮件
// 即便 SMTP 临时挂掉也不会丢数据，事后可以人工补发
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const APPLICATIONS_LOG = path.join(DATA_DIR, 'applications.jsonl');
fs.mkdirSync(DATA_DIR, { recursive: true });
console.log(`[backup] applications log: ${APPLICATIONS_LOG}`);

function appendApplication(record) {
  fs.appendFileSync(APPLICATIONS_LOG, JSON.stringify(record) + '\n', 'utf8');
}

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
let transporter = null;
if (SMTP_READY) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.qq.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  transporter.verify().then(
    () => console.log('[smtp] ready'),
    (err) => console.error('[smtp] verify failed:', err.message)
  );
} else {
  console.warn('[smtp] SMTP_USER/SMTP_PASS 未配置，进入 mock 模式：邮件内容只会输出到控制台');
}

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

    // 1) 先落盘备份 — 这是数据安全的底线，写失败才视为请求失败
    try {
      appendApplication({
        ts,
        name,
        phone,
        city,
        background,
        intro,
        ip,
        userAgent: req.headers['user-agent'] || '',
      });
    } catch (writeErr) {
      console.error('[backup] write failed:', writeErr);
      return res.status(500).json({ success: false, message: '服务异常，请稍后再试' });
    }

    // 2) 再发邮件 — 失败也不影响返回成功，数据已经安全落盘
    let mailDelivered = true;
    try {
      if (transporter) {
        await transporter.sendMail({
          from: `"百万AI动画速成班" <${process.env.SMTP_USER}>`,
          to: process.env.TO_EMAIL || process.env.SMTP_USER,
          subject: `【新报名】${name} - ${phone}`,
          html,
          replyTo: process.env.SMTP_USER,
        });
      } else {
        console.log('\n========== [mock email] ==========');
        console.log(`时间: ${ts}`);
        console.log(`收件: ${process.env.TO_EMAIL || '(未配置)'}`);
        console.log(`主题: 【新报名】${name} - ${phone}`);
        rows.forEach(([k, v]) => console.log(`  ${k}: ${k === '补充说明' ? v.replace(/<br>/g, ' / ') : v}`));
        console.log('==================================\n');
      }
    } catch (mailErr) {
      mailDelivered = false;
      console.error('[apply] mail send failed (data saved to jsonl):', mailErr.message);
    }

    res.json({ success: true, message: '提交成功', mailDelivered });
  } catch (err) {
    console.error('[apply] error:', err);
    res.status(500).json({ success: false, message: '服务异常，请稍后再试' });
  }
});

app.get('/api/health', (_req, res) => {
  let count = 0;
  try {
    if (fs.existsSync(APPLICATIONS_LOG)) {
      const stat = fs.statSync(APPLICATIONS_LOG);
      count = stat.size; // 字节数即可，避免遍历
    }
  } catch (_) { /* noop */ }
  res.json({
    ok: true,
    ts: Date.now(),
    smtp: SMTP_READY ? 'ready' : 'mock',
    backupBytes: count,
  });
});

// 本地开发：直接由 Node 后端托管整站静态文件，无需另起 web server
// 触发方式：SERVE_STATIC=1 npm start  或  npm run dev
if (SERVE_STATIC) {
  const staticDir = path.resolve(__dirname, '..');
  console.log(`[static] serving ${staticDir}`);
  app.use(express.static(staticDir, { extensions: ['html'] }));
  // SPA fallback：未匹配的路径回到 index.html（但放过 /api/*）
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || (SERVE_STATIC ? '0.0.0.0' : '127.0.0.1');
app.listen(port, host, () => {
  console.log(`[million-ai-api] listening on http://${host}:${port}`);
  if (SERVE_STATIC) console.log(`[dev] open http://localhost:${port}`);
});
