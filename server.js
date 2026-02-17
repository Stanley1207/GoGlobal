import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Multer for file uploads ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type. Allowed: JPG, PNG, WEBP, PDF'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB per file
});

// --- Gemini AI Setup ---
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenerativeAI(apiKey);
}

// Build the compliance analysis prompt
function buildAnalysisPrompt(lang = 'en') {
  const isEn = lang === 'en';

  const langInstruction = isEn
    ? `CRITICAL LANGUAGE REQUIREMENT: ALL text in your response MUST be in English. Every "name", "note", "value", "summary", "claim", "overallVerdict", and "recommendations" field MUST be written in English only. Do NOT use any Chinese characters anywhere in the response.`
    : `关键语言要求：你的回复中所有文本必须使用中文。每个 "nameCn"、"note"、"value"、"summary"、"claimCn"、"overallVerdictCn" 和 "recommendationsCn" 字段都必须用中文书写。"name" 和 "claim" 字段使用英文（作为术语标识），但 "note"、"summary"、"value" 等描述性字段必须全部使用中文。`;

  return `You are an expert FDA compliance analyst for food and dietary supplement products exported to the US market.

Analyze the uploaded product packaging/label image(s) and provide a structured compliance report.

${langInstruction}

Provide your analysis in the following JSON format ONLY (no markdown, no extra text, no code fences):
{
  "ingredientRisk": {
    "status": "pass|warn|fail",
    "flagCount": <number>,
    "items": [
      {
        "name": "<ingredient name in English>",
        "nameCn": "<ingredient name in Chinese>",
        "status": "pass|warn|fail",
        "note": "<${isEn ? 'explanation in English' : 'explanation in Chinese'}>"
      }
    ],
    "overallRisk": "<low|medium|high>",
    "riskPercent": <0-100>,
    "summary": "<${isEn ? '1-2 sentence summary in English' : '1-2句中文总结'}>"
  },
  "labelCompliance": {
    "status": "pass|warn|fail",
    "passCount": <number>,
    "totalCount": <number>,
    "items": [
      {
        "name": "<check item in English>",
        "nameCn": "<check item in Chinese>",
        "status": "pass|warn|fail",
        "note": "<${isEn ? 'brief note in English' : 'brief note in Chinese'}>"
      }
    ],
    "summary": "<${isEn ? '1-2 sentence summary in English' : '1-2句中文总结'}>"
  },
  "facilityRegistration": {
    "status": "pass|warn|info",
    "items": [
      {
        "name": "<check item in English>",
        "nameCn": "<check item in Chinese>",
        "value": "<${isEn ? 'status or value in English' : 'status or value in Chinese'}>",
        "status": "pass|warn|fail|info"
      }
    ],
    "summary": "<${isEn ? '1-2 sentence summary in English' : '1-2句中文总结'}>"
  },
  "marketingClaims": {
    "status": "pass|warn|fail",
    "issueCount": <number>,
    "items": [
      {
        "claim": "<the marketing claim found, in original language>",
        "claimCn": "<claim translated to Chinese>",
        "status": "pass|warn|fail|info",
        "note": "<${isEn ? 'explanation in English' : 'explanation in Chinese'}>"
      }
    ],
    "riskLevel": "<low|medium|high>",
    "riskPercent": <0-100>,
    "summary": "<${isEn ? '1-2 sentence summary in English' : '1-2句中文总结'}>"
  },
  "overallScore": <0-100>,
  "overallVerdict": "<${isEn ? 'brief verdict in English' : 'brief verdict in English'}>",
  "overallVerdictCn": "<brief verdict in Chinese>",
  "recommendations": [${isEn ? '"<English recommendation>"' : '"<English recommendation>"'}],
  "recommendationsCn": ["<Chinese recommendation>"]
}

IMPORTANT RULES:
1. Return ONLY valid JSON. No markdown code fences, no explanatory text before or after.
2. ${isEn ? 'All descriptive text (note, summary, value, verdict, recommendations) MUST be in English.' : 'All descriptive text (note, summary, value) MUST be in Chinese. recommendations and recommendationsCn both required.'}
3. Always provide BOTH "name" (English) and "nameCn" (Chinese) for each item.
4. Always provide BOTH "overallVerdict" (English) and "overallVerdictCn" (Chinese).
5. Always provide BOTH "recommendations" (English) and "recommendationsCn" (Chinese).
6. Be thorough and realistic. If you cannot determine something from the image, mark it as "info" status.
7. For ingredients, check against FDA GRAS list, banned substances (21 CFR 189), and color additive regulations.
8. For labels, check: Nutrition Facts format (2020 update), allergen declaration (FALCPA), net weight dual units, country of origin, English product name, manufacturer info.
9. For marketing claims, flag any unauthorized health claims, vague "natural" claims, or unverified certifications.`;
}

// --- API Routes ---

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    timestamp: new Date().toISOString()
  });
});

// Analyze uploaded files
app.post('/api/analyze', upload.array('files', 10), async (req, res) => {
  try {
    const files = req.files;
    const lang = req.body.lang || 'en';

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const genAI = getGeminiClient();
    if (!genAI) {
      // Return demo data when no API key configured
      return res.json({
        success: true,
        demo: true,
        message: 'GEMINI_API_KEY not configured. Returning demo analysis.',
        data: getDemoData(lang)
      });
    }

    // Prepare image parts for Gemini
    const imageParts = [];
    for (const file of files) {
      if (file.mimetype.startsWith('image/')) {
        const imageData = fs.readFileSync(file.path);
        imageParts.push({
          inlineData: {
            data: imageData.toString('base64'),
            mimeType: file.mimetype
          }
        });
      } else if (file.mimetype === 'application/pdf') {
        // For PDF, read as base64
        const pdfData = fs.readFileSync(file.path);
        imageParts.push({
          inlineData: {
            data: pdfData.toString('base64'),
            mimeType: 'application/pdf'
          }
        });
      }
    }

    if (imageParts.length === 0) {
      return res.status(400).json({ error: 'No valid image/PDF files found' });
    }

    // Call Gemini
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const prompt = buildAnalysisPrompt(lang);

    const result = await model.generateContent([prompt, ...imageParts]);
    const response = await result.response;
    let text = response.text();

    console.log('--- Gemini raw response (first 300 chars) ---');
    console.log(text.substring(0, 300));
    console.log('--- end ---');

    // Robust JSON extraction: find the first { and last matching }
    let data;
    try {
      // Method 1: Try direct parse after stripping code fences
      let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      data = JSON.parse(cleaned);
    } catch (e1) {
      try {
        // Method 2: Extract JSON object between first { and last }
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          const jsonStr = text.substring(firstBrace, lastBrace + 1);
          data = JSON.parse(jsonStr);
        } else {
          throw new Error('No JSON object found in response');
        }
      } catch (e2) {
        console.error('Gemini response parse error:', e2.message);
        console.error('Full raw response:', text);
        return res.status(500).json({
          error: 'Failed to parse AI response',
          raw: text.substring(0, 800)
        });
      }
    }

    // Cleanup uploaded files
    for (const file of files) {
      fs.unlink(file.path, () => {});
    }

    return res.json({ success: true, demo: false, data });
  } catch (err) {
    console.error('Analysis error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// --- Demo Data ---
function getDemoData(lang) {
  return {
    ingredientRisk: {
      status: 'warn',
      flagCount: 3,
      items: [
        { name: 'Sodium Benzoate (E211)', nameCn: '苯甲酸钠 (E211)', status: 'pass', note: 'FDA GRAS approved preservative' },
        { name: 'Red No. 40 (Allura Red)', nameCn: '诱惑红40号', status: 'warn', note: 'Requires specific listing on label per 21 CFR 74' },
        { name: 'Steviol Glycosides', nameCn: '甜菊糖苷', status: 'pass', note: 'GRAS approved sweetener' },
        { name: 'Titanium Dioxide (E171)', nameCn: '二氧化钛 (E171)', status: 'fail', note: 'Under FDA review — check latest guidance' }
      ],
      overallRisk: 'medium',
      riskPercent: 55,
      summary: lang === 'cn' ? '检测到 3 项需关注的成分标记，整体风险等级为中等。' : '3 ingredient flags detected. Overall risk level is medium.'
    },
    labelCompliance: {
      status: 'warn',
      passCount: 7,
      totalCount: 9,
      items: [
        { name: 'Nutrition Facts Format (2020)', nameCn: '营养成分表格式 (2020)', status: 'pass', note: 'Compliant' },
        { name: 'Allergen Declaration (FALCPA)', nameCn: '过敏原声明 (FALCPA)', status: 'warn', note: 'Wheat allergen needs bold or separate Contains line' },
        { name: 'Net Weight (Dual Units)', nameCn: '净含量（双单位）', status: 'fail', note: 'Missing US customary units (oz)' },
        { name: 'Country of Origin', nameCn: '原产国标注', status: 'pass', note: 'Clearly displayed' },
        { name: 'English Product Name', nameCn: '英文产品名称', status: 'pass', note: 'Present and legible' }
      ],
      summary: lang === 'cn' ? '9 项标签检查中 7 项通过，2 项需修正。' : '7 of 9 label checks passed. 2 items need correction.'
    },
    facilityRegistration: {
      status: 'info',
      items: [
        { name: 'FDA Registration Number', nameCn: 'FDA 注册编号', value: 'Not provided', status: 'info' },
        { name: 'Registration Status', nameCn: '注册状态', value: 'Needs verification', status: 'info' },
        { name: 'US Agent Designated', nameCn: '美国代理人', value: 'Unknown', status: 'warn' },
        { name: 'FSVP Importer', nameCn: 'FSVP 进口商', value: 'Pending', status: 'warn' }
      ],
      summary: lang === 'cn' ? '工厂注册信息需要手动提供以完成验证。' : 'Facility registration details need to be provided for verification.'
    },
    marketingClaims: {
      status: 'warn',
      issueCount: 2,
      items: [
        { claim: '"All Natural"', claimCn: '"纯天然"', status: 'warn', note: 'Vague claim — FDA has no formal definition' },
        { claim: '"Boosts Immunity"', claimCn: '"增强免疫力"', status: 'fail', note: 'Unauthorized health claim — requires FDA pre-approval' },
        { claim: '"Low Sugar"', claimCn: '"低糖"', status: 'pass', note: 'Meets nutrient content claim criteria' },
        { claim: '"Non-GMO"', claimCn: '"非转基因"', status: 'info', note: 'Requires third-party certification' }
      ],
      riskLevel: 'high',
      riskPercent: 72,
      summary: lang === 'cn' ? '发现 2 项宣传语言问题，风险等级较高。' : '2 marketing claim issues found. Risk level is high.'
    },
    overallScore: 68,
    overallVerdict: 'Moderate compliance — several items require attention before US market entry.',
    overallVerdictCn: '合规程度中等——多项内容需在进入美国市场前修正。',
    recommendations: [
      'Add US customary weight units (oz) alongside metric units',
      'Bold or add separate "Contains" line for wheat allergen',
      'Remove "Boosts Immunity" claim or obtain FDA authorization',
      'Clarify "All Natural" claim or remove from packaging',
      'Obtain Non-GMO Project verification if using Non-GMO claim',
      'Provide FDA facility registration number for verification'
    ],
    recommendationsCn: [
      '在公制单位旁添加美制重量单位 (oz)',
      '将小麦过敏原加粗或添加单独的"含有"说明',
      '删除"增强免疫力"宣称或获取 FDA 授权',
      '明确"纯天然"宣称含义或从包装移除',
      '如使用非转基因宣称，需获得 Non-GMO Project 认证',
      '提供 FDA 工厂注册编号以完成验证'
    ]
  };
}

// --- Fallback to index.html ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`✅ GoToMarket Compliance Lab running on port ${PORT}`);
  console.log(`   Gemini API: ${process.env.GEMINI_API_KEY ? 'Configured ✓' : 'Not configured (demo mode)'}`);
});