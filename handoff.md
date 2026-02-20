# GoToMarket Compliance Lab — 项目进展与对话摘要

> 此文档用于在新对话中延续开发进度。请在新对话开头粘贴此内容，AI 即可理解完整上下文。

---

## 项目概述

**GoToMarket Compliance Lab** 是一个面向食品及膳食补充剂出口商的 AI 驱动 FDA 合规风险筛查平台。用户上传产品包装照片，平台通过 Google Gemini 2.0 Flash API 自动生成结构化合规评估报告。

- **定位**：帮助中国企业的食品/保健品产品在进入美国市场前，进行合规风险的初步筛查与结构评估
- **目标用户**：出口贸易公司、品牌方、合规顾问
- **部署目标**：Railway（已准备好）

---

## 技术架构

| 组件 | 技术 |
|------|------|
| 前端 | 单页 HTML/CSS/JS（无框架），暗色主题，支持中英文切换 |
| 后端 | Node.js 18+ / Express (ES Modules) |
| AI | Google Gemini 2.0 Flash API |
| 数据库 | PostgreSQL（用户、报告、Session） |
| 认证 | bcryptjs + express-session + connect-pg-simple |
| 文件上传 | Multer（JPG/PNG/WEBP/PDF，最大 20MB） |
| PDF 导出 | jsPDF + jspdf-autotable（客户端生成） |

### 文件结构
```
gotomarket-app/
├── server.js           # 750 行 — Express 服务器（API、认证、Gemini、PPTX）
├── public/index.html   # 1220 行 — 完整前端（UI + 报告渲染 + PDF 导出）
├── package.json        # 10 个依赖
├── db-init.sql         # 数据库 Schema
├── .env.example        # 环境变量模板
```

---

## 功能清单与实现状态

### ✅ 已完成

| 功能 | 说明 |
|------|------|
| AI 合规分析 | 上传产品图片 → Gemini 分析 → 4维度结构化报告 |
| 4 个评估维度 | 成分风险、标签合规、工厂注册、宣传语言 |
| 法规引用 | 每个评估项附带 CFR/法条引用（21 CFR 170, DSHEA 等） |
| 监管语言 | Gemini prompt 强制使用正式法规术语 |
| 中英文切换 | 全站 data-en/data-cn 属性实现即时切换 |
| 报告独立页面 | 全屏 overlay 展示，字体放大，专业排版 |
| PDF 导出 | 封面 + 目录 + 4 节正文 + 建议 + 免责声明（英文） |
| 用户注册/登录 | PostgreSQL + bcrypt + Session |
| 报告保存 | 登录后可保存报告到数据库 |
| 我的报告 | 查看/重新打开/删除已保存报告 |
| 工厂注册措辞 | "需与工厂确认FEI/DUNS，确保有效期" + 平台不访问 FDA 数据库声明 |
| 底部免责声明 | "不构成法律意见或监管批准" |
| 三层服务结构 | Layer 3 = 销售渠道·法务对接·全球化战略规划 |
| Demo 模式 | 无 API Key 时返回模拟数据，可体验全部 UI |
| Railway 就绪 | package.json / 环境变量 / 自动建表全部配置好 |

### 🔧 最近修复的问题

1. **PDF 导出失败** — 根因：`disclaimers.forEach((d,i)` 变量 `d` 遮蔽外层报告数据；整个函数无 try-catch，错误静默失败。已修复：变量重命名 + 全函数 try-catch + CDN 加载检查。

2. **Gemini 返回英文（设置中文时）** — 已强化 prompt 中的语言指令，中文模式使用中文写的指令，明确哪些字段必须中文。

3. **JSON 解析失败** — Gemini 偶尔在 JSON 外包裹额外文本。已实现两级解析：先 strip code fence → 再提取 `{...}` 范围。

4. **PDF 空白页** — 从 html2pdf.js（基于 html2canvas 截图）完全重写为 jsPDF 程序化生成，消除渲染问题。

---

## 数据库 Schema

```sql
-- 用户表
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  company VARCHAR(200) DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 报告表
CREATE TABLE reports (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  report_id VARCHAR(50) UNIQUE NOT NULL,
  title VARCHAR(200) NOT NULL,
  data JSONB NOT NULL,          -- 完整报告 JSON
  lang VARCHAR(5) DEFAULT 'en',
  score INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Session 表 (connect-pg-simple)
CREATE TABLE "session" (
  "sid" VARCHAR NOT NULL PRIMARY KEY,
  "sess" JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);
```

启动时自动执行 `initDB()`，无需手动建表。

---

## API 路由表

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | /api/health | 否 | 健康检查 |
| POST | /api/analyze | 否 | 上传文件 → AI 分析 |
| POST | /api/generate-slides | 否 | 生成 PPTX |
| POST | /api/auth/register | 否 | 注册 |
| POST | /api/auth/login | 否 | 登录 |
| POST | /api/auth/logout | 否 | 退出 |
| GET | /api/auth/me | 否 | 当前用户 |
| POST | /api/reports | 是 | 保存报告 |
| GET | /api/reports | 是 | 列出报告 |
| GET | /api/reports/:id | 是 | 查看报告 |
| DELETE | /api/reports/:id | 是 | 删除报告 |

---

## Gemini Prompt 设计要点

- 角色：Senior FDA regulatory compliance analyst
- 输出：纯 JSON，无 markdown 包裹
- 语言控制：英文模式全英文指令，中文模式用中文写的指令
- 法规引用：每个 item 必须包含 `regulation` 字段（CFR 或法条）
- 监管术语：要求用 "GRAS determination per 21 CFR 170.30" 而非 "safe"
- 工厂注册：禁止说 "无法确定"，改用 "需确认 FEI 编号" 
- NDI：必须标注是 GRAS self-affirmed / FDA-affirmed / 还是需要 NDI notification
- 双语字段：始终提供 name (EN) + nameCn (CN)，verdict 和 recommendations 也双语

---

## 环境变量

```env
GEMINI_API_KEY=your_key          # Gemini API（无则 demo 模式）
DATABASE_URL=postgresql://...     # PostgreSQL（无则跳过用户功能）
SESSION_SECRET=random_string      # Session 加密密钥
PORT=3000
NODE_ENV=production               # 生产环境启用 secure cookie
```

---

## 部署到 Railway

1. 代码推送到 GitHub
2. Railway → New Project → Deploy from GitHub
3. 添加 PostgreSQL 插件（DATABASE_URL 自动注入）
4. 设置 GEMINI_API_KEY、SESSION_SECRET、NODE_ENV=production
5. 自动部署，数据库表自动创建

---

## 下一步可能的工作方向

以下是尚未实现但可能需要的功能（供参考）：

- [ ] 密码重置 / 忘记密码功能
- [ ] 报告分享（生成公开链接）
- [ ] 报告历史版本对比
- [ ] 付费功能 / Stripe 集成
- [ ] 管理后台（查看所有用户、报告统计）
- [ ] 多产品对比报告
- [ ] 邮件通知（报告完成、咨询回复）
- [ ] 移动端适配优化
- [ ] 接入真实 FDA 数据库 API（如可用）
- [ ] 多语言扩展（日语、韩语等）

---

## 开发者信息

- **主要开发者**：Stanley
- **技术栈背景**：React / Vue3 / Tailwind / ECharts，政府监管平台经验
- **AI 助手**：Claude (Anthropic)，持续协作开发
- **对话跨度**：2025年初至今，涵盖从零搭建到当前完整版本的全过程