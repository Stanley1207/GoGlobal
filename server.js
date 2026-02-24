import "dotenv/config";
import express from "express";
import multer from "multer";
import cors from "cors";
import path from "path";
import fs from "fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { fileURLToPath } from "url";
// import PptxGenJS from 'pptxgenjs/dist/pptxgen.bundle.js';
import pg from "pg";
import bcrypt from "bcryptjs";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";

const { Pool } = pg;
const PgSession = connectPgSimple(session);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);

// --- Middleware ---
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- PostgreSQL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(100) NOT NULL,
        company VARCHAR(200) DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        report_id VARCHAR(50) UNIQUE NOT NULL,
        title VARCHAR(200) NOT NULL DEFAULT 'Untitled Report',
        data JSONB NOT NULL,
        lang VARCHAR(5) DEFAULT 'en',
        score INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_reports_user_id ON reports(user_id);
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" VARCHAR NOT NULL COLLATE "default",
        "sess" JSON NOT NULL,
        "expire" TIMESTAMP(6) NOT NULL,
        CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
      );
      CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
    `);
    console.log("   Database: Tables initialized ✓");
  } catch (err) {
    console.error("   Database: Init failed -", err.message);
  }
}

// --- Session ---
app.use(
  session({
    store: process.env.DATABASE_URL
      ? new PgSession({ pool, tableName: "session" })
      : undefined,
    secret:
      process.env.SESSION_SECRET || "gotomarket-dev-secret-change-in-prod",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    },
  }),
);

// Auth helper
function requireAuth(req, res, next) {
  if (!req.session.userId)
    return res.status(401).json({ error: "Not authenticated" });
  next();
}

// --- Multer for file uploads ---
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e6);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Unsupported file type. Allowed: JPG, PNG, WEBP, PDF"), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB per file
});

// --- Gemini AI Setup ---
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenerativeAI(apiKey);
}

// Build the compliance analysis prompt
function buildAnalysisPrompt(lang = "en") {
  const isEn = lang === "en";

  const langInstruction = isEn
    ? `CRITICAL LANGUAGE REQUIREMENT: ALL text in your response MUST be in English. Every "name", "note", "value", "summary", "claim", "overallVerdict", and "recommendations" field MUST be written in English only. Do NOT use any Chinese characters anywhere in the response.`
    : `关键语言要求：你的回复中所有文本必须使用中文。每个 "nameCn"、"note"、"value"、"summary"、"claimCn"、"overallVerdictCn" 和 "recommendationsCn" 字段都必须用中文书写。"name" 和 "claim" 字段使用英文（作为术语标识），但 "note"、"summary"、"value" 等描述性字段必须全部使用中文。`;

  return `You are a senior regulatory compliance analyst specializing in food and dietary supplement products exported to the US market. Use formal regulatory language in your analysis. Focus on structural compliance assessment rather than definitive pass/fail judgments.

Analyze the uploaded product packaging/label image(s) and provide a structured compliance assessment report.

${langInstruction}

IMPORTANT REGULATORY CITATION RULES:
- For each item, include a "regulation" field with the specific CFR or statutory reference.
- Examples: "21 CFR 170.30 (GRAS)", "21 CFR 101.36 (Supplement Facts)", "DSHEA Sec. 403(r)(6)", "21 CFR 189 (Prohibited Substances)", "21 CFR 74 (Color Additives)", "FALCPA Sec. 203", "21 CFR 101.9 (Nutrition Labeling)", "FD&C Act Sec. 403(a)(1)"
- Use precise regulatory terminology: "GRAS determination per 21 CFR 170" not just "safe"
- For ingredients: note whether GRAS self-determination, FDA-affirmed GRAS, or NDI notification required
- For facility: reference 21 CFR 1.225 (Registration of Food Facilities) and FSMA Sec. 301

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
        "note": "<${isEn ? "regulatory assessment in English" : "regulatory assessment in Chinese"}>",
        "regulation": "<e.g. 21 CFR 170.30 (GRAS)>"
      }
    ],
    "overallRisk": "<low|medium|high>",
    "riskPercent": <0-100>,
    "summary": "<${isEn ? "1-2 sentence summary in English" : "1-2句中文总结"}>"
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
        "note": "<${isEn ? "brief note in English" : "brief note in Chinese"}>",
        "regulation": "<e.g. 21 CFR 101.9>"
      }
    ],
    "summary": "<${isEn ? "1-2 sentence summary in English" : "1-2句中文总结"}>"
  },
  "facilityRegistration": {
    "status": "pass|warn|info",
    "items": [
      {
        "name": "<check item in English>",
        "nameCn": "<check item in Chinese>",
        "value": "<${isEn ? "status or value in English" : "status or value in Chinese"}>",
        "status": "pass|warn|fail|info",
        "regulation": "<e.g. 21 CFR 1.225>"
      }
    ],
    "summary": "<${isEn ? "1-2 sentence summary in English" : "1-2句中文总结"}>"
  },
  "marketingClaims": {
    "status": "pass|warn|fail",
    "issueCount": <number>,
    "items": [
      {
        "claim": "<the marketing claim found, in original language>",
        "claimCn": "<claim translated to Chinese>",
        "status": "pass|warn|fail|info",
        "note": "<${isEn ? "explanation in English" : "explanation in Chinese"}>",
        "regulation": "<e.g. DSHEA Sec. 403(r)(6)>"
      }
    ],
    "riskLevel": "<low|medium|high>",
    "riskPercent": <0-100>,
    "summary": "<${isEn ? "1-2 sentence summary in English" : "1-2句中文总结"}>"
  },
  "overallRiskLevel": "<low|medium|high>",
  "overallVerdict": "<${isEn ? "structural risk assessment verdict in English" : "structural risk assessment verdict in English"}>",
  "overallVerdictCn": "<brief verdict in Chinese>",
  "recommendations": [${isEn ? '"<English recommendation>"' : '"<English recommendation>"'}],
  "recommendationsCn": ["<Chinese recommendation>"]
}

IMPORTANT RULES:
1. Return ONLY valid JSON. No markdown code fences, no explanatory text before or after.
2. ${isEn ? "All descriptive text (note, summary, value, verdict, recommendations) MUST be in English." : "All descriptive text (note, summary, value) MUST be in Chinese. recommendations and recommendationsCn both required."}
3. Always provide BOTH "name" (English) and "nameCn" (Chinese) for each item.
4. Always provide BOTH "overallVerdict" (English) and "overallVerdictCn" (Chinese).
5. Always provide BOTH "recommendations" (English) and "recommendationsCn" (Chinese).
6. ALWAYS include "regulation" field with specific CFR/statutory citation for EVERY item.
7. Use formal regulatory language: "Requires verification of GRAS status per 21 CFR 170.30" not "Generally safe".
8. For facility registration: DO NOT say "unable to determine". Instead note "Requires confirmation of facility FEI number and valid registration status per 21 CFR 1.225".
9. For ingredients, specify whether GRAS self-affirmed, FDA-affirmed, or NDI notification required per DSHEA.
10. For labels, cite specific CFR sections (21 CFR 101.9, 101.36, etc.).
11. For marketing claims, reference FD&C Act Sec. 403, DSHEA structure/function claim rules.
12. For overallRiskLevel, use "low", "medium", or "high" to indicate structural risk. Do NOT use numeric scores.
13. Avoid absolute negative terms like "violation", "adulteration", "counterfeit". Use "structural risk", "requires optimization", "warrants review" instead.
14. Do NOT use terms like "certification", "approval" for this platform's output. Use "structural assessment", "risk identification" instead.`;
}

// Robust JSON extraction from Gemini response
function parseGeminiJSON(text) {
  try {
    const cleaned = text
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
    return JSON.parse(cleaned);
  } catch (e1) {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const jsonStr = text.substring(firstBrace, lastBrace + 1);
      return JSON.parse(jsonStr);
    }
    throw new Error("No JSON object found in response");
  }
}

// Build extraction prompt (Layer 1: extract structured data from images)
function buildExtractionPrompt(lang = "en") {
  const isEn = lang === "en";
  const langRule = isEn
    ? "Use English for all fields."
    : "Use Chinese where possible for descriptive fields; use English for technical/regulatory terms and field keys.";

  return `You are an expert at reading product packaging, labels, and ingredient lists for food and dietary supplement products.

Analyze the uploaded product image(s) and extract ALL visible structured data. Do NOT perform compliance analysis — only extract what you see.

${langRule}

Return ONLY valid JSON with this exact structure (no markdown, no code fences, no extra text):
{
  "productName": "<product name as shown on label>",
  "productNameCn": "<product name in Chinese if visible, or translation>",
  "productType": "<food / dietary supplement / beverage / other>",
  "ingredients": [
    {
      "name": "<ingredient name in English>",
      "nameCn": "<ingredient name in Chinese if visible>",
      "amount": "<amount or percentage if visible, or empty string>",
      "unit": "<unit if visible, or empty string>"
    }
  ],
  "nutritionFacts": [
    { "nutrient": "<nutrient name>", "amount": "<value with unit>", "dailyValue": "<% DV if shown, or empty>" }
  ],
  "allergens": ["<allergen 1>", "<allergen 2>"],
  "netWeight": "<net weight as shown on label>",
  "servingSize": "<serving size as shown>",
  "servingsPerContainer": "<servings per container if shown>",
  "countryOfOrigin": "<country if visible>",
  "manufacturerInfo": "<manufacturer name and/or address if visible>",
  "labelClaims": [
    { "claim": "<marketing or health claim text in English>", "claimCn": "<Chinese translation or original if Chinese>" }
  ],
  "fdaInfo": {
    "facilityIdNumber": "<FEI or facility identification number if visible, or empty string>"
  },
  "otherInfo": "<any other relevant label information not captured above>"
}

RULES:
1. Extract ONLY what is visible on the label/packaging. Use empty string "" for fields not found.
2. For ingredients, list EVERY ingredient separately, in the order shown on the label.
3. If an ingredient list shows sub-ingredients in parentheses, list the parent ingredient with sub-ingredients noted in the amount field.
4. Return ONLY valid JSON. No markdown code fences, no explanatory text.
5. If multiple images are provided, combine information from all images into one unified response.`;
}

// Build confirmed analysis prompt (Layer 2: analyze confirmed structured data)
function buildConfirmedAnalysisPrompt(lang = "en") {
  const isEn = lang === "en";

  const langInstruction = isEn
    ? `CRITICAL LANGUAGE REQUIREMENT: ALL text in your response MUST be in English. Every "name", "note", "value", "summary", "claim", "overallVerdict", and "recommendations" field MUST be written in English only. Do NOT use any Chinese characters anywhere in the response.`
    : `关键语言要求：你的回复中所有文本必须使用中文。每个 "nameCn"、"note"、"value"、"summary"、"claimCn"、"overallVerdictCn" 和 "recommendationsCn" 字段都必须用中文书写。"name" 和 "claim" 字段使用英文（作为术语标识），但 "note"、"summary"、"value" 等描述性字段必须全部使用中文。`;

  return `You are a senior regulatory compliance analyst specializing in food and dietary supplement products exported to the US market. Use formal regulatory language in your analysis. Focus on structural compliance assessment rather than definitive pass/fail judgments.

Analyze the following CONFIRMED product data (provided as structured text below) and provide a structured compliance assessment report. This data has been reviewed and confirmed by the product owner as accurate.

${langInstruction}

IMPORTANT REGULATORY CITATION RULES:
- For each item, include a "regulation" field with the specific CFR or statutory reference.
- Examples: "21 CFR 170.30 (GRAS)", "21 CFR 101.36 (Supplement Facts)", "DSHEA Sec. 403(r)(6)", "21 CFR 189 (Prohibited Substances)", "21 CFR 74 (Color Additives)", "FALCPA Sec. 203", "21 CFR 101.9 (Nutrition Labeling)", "FD&C Act Sec. 403(a)(1)"
- Use precise regulatory terminology: "GRAS determination per 21 CFR 170" not just "safe"
- For ingredients: note whether GRAS self-determination, FDA-affirmed GRAS, or NDI notification required
- For facility: reference 21 CFR 1.225 (Registration of Food Facilities) and FSMA Sec. 301

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
        "note": "<${isEn ? "regulatory assessment in English" : "regulatory assessment in Chinese"}>",
        "regulation": "<e.g. 21 CFR 170.30 (GRAS)>"
      }
    ],
    "overallRisk": "<low|medium|high>",
    "riskPercent": <0-100>,
    "summary": "<${isEn ? "1-2 sentence summary in English" : "1-2句中文总结"}>"
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
        "note": "<${isEn ? "brief note in English" : "brief note in Chinese"}>",
        "regulation": "<e.g. 21 CFR 101.9>"
      }
    ],
    "summary": "<${isEn ? "1-2 sentence summary in English" : "1-2句中文总结"}>"
  },
  "facilityRegistration": {
    "status": "pass|warn|info",
    "items": [
      {
        "name": "<check item in English>",
        "nameCn": "<check item in Chinese>",
        "value": "<${isEn ? "status or value in English" : "status or value in Chinese"}>",
        "status": "pass|warn|fail|info",
        "regulation": "<e.g. 21 CFR 1.225>"
      }
    ],
    "summary": "<${isEn ? "1-2 sentence summary in English" : "1-2句中文总结"}>"
  },
  "marketingClaims": {
    "status": "pass|warn|fail",
    "issueCount": <number>,
    "items": [
      {
        "claim": "<the marketing claim found, in original language>",
        "claimCn": "<claim translated to Chinese>",
        "status": "pass|warn|fail|info",
        "note": "<${isEn ? "explanation in English" : "explanation in Chinese"}>",
        "regulation": "<e.g. DSHEA Sec. 403(r)(6)>"
      }
    ],
    "riskLevel": "<low|medium|high>",
    "riskPercent": <0-100>,
    "summary": "<${isEn ? "1-2 sentence summary in English" : "1-2句中文总结"}>"
  },
  "overallRiskLevel": "<low|medium|high>",
  "overallVerdict": "<${isEn ? "structural risk assessment verdict in English" : "structural risk assessment verdict in English"}>",
  "overallVerdictCn": "<brief verdict in Chinese>",
  "recommendations": [${isEn ? '"<English recommendation>"' : '"<English recommendation>"'}],
  "recommendationsCn": ["<Chinese recommendation>"]
}

IMPORTANT RULES:
1. Return ONLY valid JSON. No markdown code fences, no explanatory text before or after.
2. ${isEn ? "All descriptive text (note, summary, value, verdict, recommendations) MUST be in English." : "All descriptive text (note, summary, value) MUST be in Chinese. recommendations and recommendationsCn both required."}
3. Always provide BOTH "name" (English) and "nameCn" (Chinese) for each item.
4. Always provide BOTH "overallVerdict" (English) and "overallVerdictCn" (Chinese).
5. Always provide BOTH "recommendations" (English) and "recommendationsCn" (Chinese).
6. ALWAYS include "regulation" field with specific CFR/statutory citation for EVERY item.
7. Use formal regulatory language: "Requires verification of GRAS status per 21 CFR 170.30" not "Generally safe".
8. For facility registration: Assess based on user-reported status selections (not verified data). Use phrases like "Based on provided information" and "Independent verification recommended".
9. For ingredients, specify whether GRAS self-affirmed, FDA-affirmed, or NDI notification required per DSHEA.
10. For labels, cite specific CFR sections (21 CFR 101.9, 101.36, etc.).
11. For marketing claims, reference FD&C Act Sec. 403, DSHEA structure/function claim rules.
12. For overallRiskLevel, use "low", "medium", or "high" to indicate structural risk. Do NOT use numeric scores.
13. Avoid absolute negative terms like "violation", "adulteration", "counterfeit". Use "structural risk", "requires optimization", "warrants review" instead.
14. Do NOT use terms like "certification", "approval" for this platform's output. Use "structural assessment", "risk identification" instead.
15. NEVER use "FDA verified", "Compliant", or "Registration confirmed" in output. Use "Based on provided information", "Independent verification recommended", "Structural risk level: Low/Moderate/Elevated" instead.
16. All facility registration data is user-reported and NOT independently verified against FDA databases. Always note this context in facility-related assessments.`;
}

// Format confirmed data as structured text for Layer 2 prompt
function formatConfirmedDataAsText(d) {
  let text = `PRODUCT NAME: ${d.productName || "Not specified"}\n`;
  if (d.productNameCn) text += `PRODUCT NAME (CN): ${d.productNameCn}\n`;
  if (d.productType) text += `PRODUCT TYPE: ${d.productType}\n`;
  text += "\n";

  text += "INGREDIENTS:\n";
  if (d.ingredients && d.ingredients.length) {
    d.ingredients.forEach((ing, i) => {
      text += `  ${i + 1}. ${ing.name || ing.nameCn || "Unknown"}`;
      if (ing.nameCn && ing.name) text += ` (${ing.nameCn})`;
      if (ing.amount)
        text += ` — ${ing.amount}${ing.unit ? " " + ing.unit : ""}`;
      text += "\n";
    });
  } else {
    text += "  No ingredients provided.\n";
  }
  text += "\n";

  text += "NUTRITION FACTS:\n";
  if (d.nutritionFacts && d.nutritionFacts.length) {
    d.nutritionFacts.forEach((nf) => {
      text += `  ${nf.nutrient}: ${nf.amount}`;
      if (nf.dailyValue) text += ` (${nf.dailyValue} DV)`;
      text += "\n";
    });
  } else {
    text += "  No nutrition facts provided.\n";
  }
  text += "\n";

  text += `ALLERGENS: ${d.allergens && d.allergens.length ? d.allergens.join(", ") : "None declared"}\n`;
  text += `NET WEIGHT: ${d.netWeight || "Not specified"}\n`;
  text += `SERVING SIZE: ${d.servingSize || "Not specified"}\n`;
  if (d.servingsPerContainer)
    text += `SERVINGS PER CONTAINER: ${d.servingsPerContainer}\n`;
  text += `COUNTRY OF ORIGIN: ${d.countryOfOrigin || "Not specified"}\n`;
  text += `MANUFACTURER: ${d.manufacturerInfo || "Not specified"}\n\n`;

  text += "LABEL CLAIMS:\n";
  if (d.labelClaims && d.labelClaims.length) {
    d.labelClaims.forEach((c) => {
      text += `  - ${c.claim}`;
      if (c.claimCn) text += ` (${c.claimCn})`;
      text += "\n";
    });
  } else {
    text += "  No marketing or health claims found.\n";
  }
  text += "\n";

  text +=
    "FDA FACILITY REGISTRATION STATUS (user-reported, not independently verified):\n";
  const fs = d.fdaStatus || {};
  const regMap = {
    active: "Confirmed active",
    expired: "Possibly expired",
    not_registered: "Not registered",
    unknown: "Unknown",
  };
  const agentMap = {
    appointed: "Appointed",
    not_appointed: "Not appointed",
    unknown: "Unknown",
  };
  const fsvpMap = { yes: "Yes", no: "No", tbd: "To be determined" };
  const importerMap = {
    us_distributor: "U.S. distributor",
    self_import: "Self-import",
    third_party: "Third-party importer",
    not_determined: "Not determined",
  };
  text += `  Manufacturing Facility Registration: ${regMap[fs.facilityRegStatus] || "Unknown"}\n`;
  text += `  U.S. Agent Appointment: ${agentMap[fs.usAgentStatus] || "Unknown"}\n`;
  text += `  FSVP Importer Identified: ${fsvpMap[fs.fsvpStatus] || "To be determined"}\n`;
  text += `  Importer of Record Structure: ${importerMap[fs.importerStructure] || "Not determined"}\n`;
  if (fs.facilityIdNumber) {
    text += `  Facility ID Number (user-provided, not verified): ${fs.facilityIdNumber}\n`;
  }

  return text;
}

// Demo extraction data for when no API key is configured
function getDemoExtractedData(lang) {
  const cn = lang === "cn";
  return {
    productName: cn ? "超级能量饮品" : "Super Energy Drink",
    productNameCn: "超级能量饮品",
    productType: cn ? "饮料" : "beverage",
    ingredients: [
      { name: "Carbonated Water", nameCn: "碳酸水", amount: "", unit: "" },
      {
        name: "High Fructose Corn Syrup",
        nameCn: "高果糖玉米糖浆",
        amount: "",
        unit: "",
      },
      { name: "Citric Acid", nameCn: "柠檬酸", amount: "", unit: "" },
      { name: "Sodium Benzoate", nameCn: "苯甲酸钠", amount: "0.1", unit: "%" },
      { name: "Red No. 40", nameCn: "诱惑红40号", amount: "", unit: "" },
      { name: "Caffeine", nameCn: "咖啡因", amount: "80", unit: "mg" },
      { name: "Taurine", nameCn: "牛磺酸", amount: "1000", unit: "mg" },
      { name: "Steviol Glycosides", nameCn: "甜菊糖苷", amount: "", unit: "" },
    ],
    nutritionFacts: [
      { nutrient: "Calories", amount: "110", dailyValue: "" },
      { nutrient: "Total Fat", amount: "0g", dailyValue: "0%" },
      { nutrient: "Sodium", amount: "40mg", dailyValue: "2%" },
      { nutrient: "Total Carbohydrate", amount: "28g", dailyValue: "10%" },
      { nutrient: "Total Sugars", amount: "27g", dailyValue: "" },
      { nutrient: "Protein", amount: "0g", dailyValue: "" },
    ],
    allergens: [],
    netWeight: "250ml",
    servingSize: "1 can (250ml)",
    servingsPerContainer: "1",
    countryOfOrigin: "China",
    manufacturerInfo: "XYZ Beverage Co., Guangzhou, China",
    labelClaims: [
      { claim: "All Natural Energy", claimCn: "纯天然能量" },
      { claim: "Boosts Performance", claimCn: "提升表现" },
      { claim: "Low Sugar", claimCn: "低糖" },
    ],
    fdaStatus: {
      facilityRegStatus: "unknown",
      usAgentStatus: "unknown",
      fsvpStatus: "tbd",
      importerStructure: "not_determined",
      facilityIdNumber: "",
    },
    otherInfo: "",
  };
}

// --- API Routes ---

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    dbConfigured: !!process.env.DATABASE_URL,
    timestamp: new Date().toISOString(),
  });
});

// ==================== AUTH ROUTES ====================

// Register
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password, name, company } = req.body;
    if (!email || !password || !name)
      return res
        .status(400)
        .json({ error: "Email, password, and name are required" });
    if (password.length < 6)
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });

    const existing = await pool.query("SELECT id FROM users WHERE email=$1", [
      email.toLowerCase().trim(),
    ]);
    if (existing.rows.length)
      return res.status(409).json({ error: "Email already registered" });

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      "INSERT INTO users (email, password_hash, name, company) VALUES ($1,$2,$3,$4) RETURNING id, email, name, company, created_at",
      [email.toLowerCase().trim(), hash, name.trim(), (company || "").trim()],
    );
    const user = result.rows[0];
    req.session.userId = user.id;
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        company: user.company,
      },
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// Login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password are required" });

    const result = await pool.query(
      "SELECT id, email, name, company, password_hash FROM users WHERE email=$1",
      [email.toLowerCase().trim()],
    );
    if (!result.rows.length)
      return res.status(401).json({ error: "Invalid email or password" });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ error: "Invalid email or password" });

    req.session.userId = user.id;
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        company: user.company,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// Logout
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// Get current user
app.get("/api/auth/me", async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  try {
    const result = await pool.query(
      "SELECT id, email, name, company FROM users WHERE id=$1",
      [req.session.userId],
    );
    if (!result.rows.length) return res.json({ user: null });
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.json({ user: null });
  }
});

// ==================== REPORT ROUTES ====================

// Save report
app.post("/api/reports", requireAuth, async (req, res) => {
  try {
    const { reportData, lang, title } = req.body;
    if (!reportData)
      return res.status(400).json({ error: "Report data is required" });

    const reportId = "GTM-" + Date.now().toString(36).toUpperCase();
    const riskLevel = reportData.overallRiskLevel || "medium";
    const score = riskLevel === "low" ? 1 : riskLevel === "high" ? 3 : 2;
    const reportTitle =
      title ||
      (lang === "cn"
        ? "产品合规结构评估报告"
        : "Product Compliance Structural Assessment Report");

    const result = await pool.query(
      "INSERT INTO reports (user_id, report_id, title, data, lang, score) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, report_id, title, score, created_at",
      [
        req.session.userId,
        reportId,
        reportTitle,
        JSON.stringify(reportData),
        lang || "en",
        score,
      ],
    );
    res.json({ success: true, report: result.rows[0] });
  } catch (err) {
    console.error("Save report error:", err);
    res.status(500).json({ error: "Failed to save report" });
  }
});

// List user's reports
app.get("/api/reports", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, report_id, title, score, lang, created_at FROM reports WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50",
      [req.session.userId],
    );
    res.json({ reports: result.rows });
  } catch (err) {
    console.error("List reports error:", err);
    res.status(500).json({ error: "Failed to list reports" });
  }
});

// Get single report
app.get("/api/reports/:reportId", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, report_id, title, data, score, lang, created_at FROM reports WHERE report_id=$1 AND user_id=$2",
      [req.params.reportId, req.session.userId],
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Report not found" });
    res.json({ report: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Failed to load report" });
  }
});

// Delete report
app.delete("/api/reports/:reportId", requireAuth, async (req, res) => {
  try {
    await pool.query("DELETE FROM reports WHERE report_id=$1 AND user_id=$2", [
      req.params.reportId,
      req.session.userId,
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete report" });
  }
});

// Helper: read uploaded files as base64 parts for Gemini
function filesToImageParts(files) {
  const imageParts = [];
  for (const file of files) {
    if (file.mimetype.startsWith("image/")) {
      imageParts.push({
        inlineData: {
          data: fs.readFileSync(file.path).toString("base64"),
          mimeType: file.mimetype,
        },
      });
    } else if (file.mimetype === "application/pdf") {
      imageParts.push({
        inlineData: {
          data: fs.readFileSync(file.path).toString("base64"),
          mimeType: "application/pdf",
        },
      });
    }
  }
  return imageParts;
}

// Helper: cleanup uploaded files
function cleanupFiles(files) {
  for (const file of files) {
    fs.unlink(file.path, () => {});
  }
}

// Analyze uploaded files (legacy single-step endpoint)
app.post("/api/analyze", upload.array("files", 10), async (req, res) => {
  try {
    const files = req.files;
    const lang = req.body.lang || "en";

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const genAI = getGeminiClient();
    if (!genAI) {
      return res.json({
        success: true,
        demo: true,
        message: "GEMINI_API_KEY not configured. Returning demo analysis.",
        data: getDemoData(lang),
      });
    }

    const imageParts = filesToImageParts(files);
    if (imageParts.length === 0) {
      return res.status(400).json({ error: "No valid image/PDF files found" });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
    const result = await model.generateContent([
      buildAnalysisPrompt(lang),
      ...imageParts,
    ]);
    const text = (await result.response).text();

    console.log("--- Gemini analyze response (first 300 chars) ---");
    console.log(text.substring(0, 300));
    console.log("--- end ---");

    let data;
    try {
      data = parseGeminiJSON(text);
    } catch (e) {
      console.error("Gemini response parse error:", e.message);
      return res.status(500).json({
        error: "Failed to parse AI response",
        raw: text.substring(0, 800),
      });
    }

    cleanupFiles(files);
    return res.json({ success: true, demo: false, data });
  } catch (err) {
    console.error("Analysis error:", err);
    return res
      .status(500)
      .json({ error: err.message || "Internal server error" });
  }
});

// Layer 1: Extract structured product data from images
app.post("/api/extract", upload.array("files", 10), async (req, res) => {
  try {
    const files = req.files;
    const lang = req.body.lang || "en";

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const genAI = getGeminiClient();
    if (!genAI) {
      cleanupFiles(files);
      return res.json({
        success: true,
        demo: true,
        message: "GEMINI_API_KEY not configured. Returning demo extraction.",
        data: getDemoExtractedData(lang),
      });
    }

    const imageParts = filesToImageParts(files);
    if (imageParts.length === 0) {
      return res.status(400).json({ error: "No valid image/PDF files found" });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
    const result = await model.generateContent([
      buildExtractionPrompt(lang),
      ...imageParts,
    ]);
    const text = (await result.response).text();

    console.log("--- Gemini extract response (first 300 chars) ---");
    console.log(text.substring(0, 300));
    console.log("--- end ---");

    let data;
    try {
      data = parseGeminiJSON(text);
    } catch (e) {
      console.error("Extraction parse error:", e.message);
      return res.status(500).json({
        error: "Failed to parse AI extraction response",
        raw: text.substring(0, 800),
      });
    }

    cleanupFiles(files);
    return res.json({ success: true, demo: false, data });
  } catch (err) {
    console.error("Extraction error:", err);
    return res
      .status(500)
      .json({ error: err.message || "Internal server error" });
  }
});

// Layer 2: Analyze confirmed product data (text only, no images)
app.post("/api/analyze-confirmed", async (req, res) => {
  try {
    const { confirmedData, lang } = req.body;
    if (!confirmedData) {
      return res.status(400).json({ error: "No confirmed data provided" });
    }

    const genAI = getGeminiClient();
    if (!genAI) {
      return res.json({
        success: true,
        demo: true,
        message: "GEMINI_API_KEY not configured. Returning demo analysis.",
        data: getDemoData(lang || "en"),
      });
    }

    const dataText = formatConfirmedDataAsText(confirmedData);
    const prompt =
      buildConfirmedAnalysisPrompt(lang || "en") +
      "\n\n--- CONFIRMED PRODUCT DATA ---\n" +
      dataText;

    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
    const result = await model.generateContent(prompt);
    const text = (await result.response).text();

    console.log("--- Gemini confirmed-analysis response (first 300 chars) ---");
    console.log(text.substring(0, 300));
    console.log("--- end ---");

    let data;
    try {
      data = parseGeminiJSON(text);
    } catch (e) {
      console.error("Confirmed analysis parse error:", e.message);
      return res.status(500).json({
        error: "Failed to parse AI response",
        raw: text.substring(0, 800),
      });
    }

    return res.json({ success: true, demo: false, data });
  } catch (err) {
    console.error("Confirmed analysis error:", err);
    return res
      .status(500)
      .json({ error: err.message || "Internal server error" });
  }
});

// // --- Generate PPTX Slides from report data ---
// app.post('/api/generate-slides', express.json({ limit: '5mb' }), async (req, res) => {
//   try {
//     const { data, lang } = req.body;
//     const d = data || getDemoData(lang || 'en');
//     const cn = lang === 'cn';

//     const pptx = new PptxGenJS();
//     pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 inches
//     pptx.author = 'GoToMarket Compliance Lab';
//     pptx.title = cn ? '产品合规结构评估报告' : 'Product Compliance Assessment Report';

//     // Brand colors
//     const ACCENT = '0D9373';
//     const DARK = '1A1A2E';
//     const MID = '64647A';
//     const LIGHT = '9696AA';
//     const BG = 'F5F7FA';
//     const WHITE = 'FFFFFF';
//     const PASS = '16A34A';
//     const WARN = 'D97706';
//     const FAIL = 'DC2626';
//     const INFO = '2563EB';
//     const statusClr = s => s === 'pass' ? PASS : s === 'warn' ? WARN : s === 'fail' ? FAIL : INFO;

//     // ============ SLIDE 1: Title ============
//     const s1 = pptx.addSlide();
//     // Top accent bar
//     s1.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.06, fill: { color: ACCENT } });
//     // Background
//     s1.background = { fill: WHITE };
//     // Logo area
//     s1.addText('GT', { x: 0.6, y: 0.5, w: 0.5, h: 0.5, fontSize: 18, bold: true, color: WHITE, align: 'center', valign: 'middle', fill: { color: ACCENT }, shape: pptx.ShapeType.roundRect, rectRadius: 0.08 });
//     s1.addText('GoToMarket Compliance Lab', { x: 1.25, y: 0.52, w: 4, h: 0.45, fontSize: 16, bold: true, color: ACCENT, fontFace: 'Helvetica' });
//     // Main title
//     s1.addText(cn ? 'Product Compliance\nAssessment Report' : 'Product Compliance\nAssessment Report', { x: 0.6, y: 2.0, w: 8, h: 1.8, fontSize: 40, bold: true, color: DARK, fontFace: 'Helvetica', lineSpacingMultiple: 1.1 });
//     // Subtitle
//     s1.addText('Global Regulatory & Market Entry Intelligence Platform', { x: 0.6, y: 3.9, w: 8, h: 0.5, fontSize: 14, color: ACCENT, fontFace: 'Helvetica' });
//     // Meta info
//     const now = new Date();
//     const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
//     const reportId = 'GTM-' + Date.now().toString(36).toUpperCase();
//     s1.addText(`Report Date: ${dateStr}  |  ID: ${reportId}`, { x: 0.6, y: 5.2, w: 8, h: 0.35, fontSize: 10, color: LIGHT, fontFace: 'Helvetica' });
//     // Score circle on right
//     s1.addShape(pptx.ShapeType.ellipse, { x: 9.8, y: 2.2, w: 2.2, h: 2.2, fill: { color: 'F0FAF6' }, line: { color: ACCENT, width: 3 } });
//     s1.addText(String(d.overallScore), { x: 9.8, y: 2.35, w: 2.2, h: 1.5, fontSize: 44, bold: true, color: ACCENT, align: 'center', valign: 'middle', fontFace: 'Helvetica' });
//     s1.addText('/100', { x: 9.8, y: 3.5, w: 2.2, h: 0.5, fontSize: 12, color: LIGHT, align: 'center', fontFace: 'Helvetica' });
//     // Verdict
//     const verdict = cn ? (d.overallVerdictCn || d.overallVerdict) : d.overallVerdict;
//     s1.addText(verdict || '', { x: 0.6, y: 5.7, w: 11, h: 0.5, fontSize: 11, color: MID, fontFace: 'Helvetica', italic: true });
//     // Bottom bar
//     s1.addShape(pptx.ShapeType.rect, { x: 0, y: 7.2, w: '100%', h: 0.3, fill: { color: ACCENT } });
//     s1.addText('Confidential  •  For Internal Use Only', { x: 0.6, y: 7.22, w: 12, h: 0.26, fontSize: 8, color: WHITE, fontFace: 'Helvetica' });

//     // ============ Helper: Section Slide ============
//     function addSectionSlide(icon, title, badgeText, badgeStatus, items, nameKey, noteKey, summary, riskPercent, riskLabel) {
//       const s = pptx.addSlide();
//       s.background = { fill: WHITE };
//       // Top bar
//       s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.06, fill: { color: ACCENT } });
//       // Section header bar
//       s.addShape(pptx.ShapeType.roundRect, { x: 0.5, y: 0.4, w: 12.3, h: 0.6, fill: { color: BG }, rectRadius: 0.06 });
//       s.addText(`${icon}  ${title}`, { x: 0.7, y: 0.42, w: 8, h: 0.55, fontSize: 16, bold: true, color: DARK, fontFace: 'Helvetica' });
//       // Badge
//       s.addShape(pptx.ShapeType.roundRect, { x: 11.0, y: 0.47, w: 1.6, h: 0.4, fill: { color: statusClr(badgeStatus) }, rectRadius: 0.06 });
//       s.addText(badgeText, { x: 11.0, y: 0.47, w: 1.6, h: 0.4, fontSize: 10, bold: true, color: WHITE, align: 'center', valign: 'middle', fontFace: 'Helvetica' });

//       // Table
//       const headerRow = [
//         { text: cn ? 'Item' : 'Item', options: { bold: true, fontSize: 9, color: LIGHT, fill: { color: BG }, fontFace: 'Helvetica', align: 'left' } },
//         { text: cn ? 'Status / Note' : 'Status / Note', options: { bold: true, fontSize: 9, color: LIGHT, fill: { color: BG }, fontFace: 'Helvetica', align: 'right' } }
//       ];
//       const bodyRows = items.map(it => {
//         const name = cn ? (it[nameKey + 'Cn'] || it[nameKey]) : it[nameKey];
//         const note = it[noteKey] || it.status || '';
//         return [
//           { text: name || '', options: { fontSize: 10, color: DARK, fontFace: 'Helvetica' } },
//           { text: note || '', options: { fontSize: 10, color: statusClr(it.status), fontFace: 'Helvetica', align: 'right', bold: true } }
//         ];
//       });

//       s.addTable([headerRow, ...bodyRows], {
//         x: 0.5, y: 1.25, w: 12.3,
//         border: { type: 'solid', pt: 0.5, color: 'E5E7EB' },
//         colW: [6.15, 6.15],
//         rowH: 0.42,
//         autoPage: false,
//         margin: [4, 8, 4, 8]
//       });

//       let yPos = 1.25 + (items.length + 1) * 0.42 + 0.3;

//       // Risk bar
//       if (typeof riskPercent === 'number') {
//         s.addText(riskLabel || 'Risk', { x: 0.5, y: yPos, w: 3, h: 0.25, fontSize: 8, color: LIGHT, fontFace: 'Helvetica' });
//         const rl = riskPercent > 65 ? 'High' : riskPercent > 35 ? 'Medium' : 'Low';
//         s.addText(rl, { x: 9.8, y: yPos, w: 3, h: 0.25, fontSize: 8, color: LIGHT, fontFace: 'Helvetica', align: 'right' });
//         yPos += 0.28;
//         // Bar bg
//         s.addShape(pptx.ShapeType.roundRect, { x: 0.5, y: yPos, w: 12.3, h: 0.18, fill: { color: 'E5E7EB' }, rectRadius: 0.04 });
//         // Bar fill
//         const barW = 12.3 * riskPercent / 100;
//         const barClr = riskPercent > 65 ? FAIL : riskPercent > 35 ? WARN : PASS;
//         s.addShape(pptx.ShapeType.roundRect, { x: 0.5, y: yPos, w: barW, h: 0.18, fill: { color: barClr }, rectRadius: 0.04 });
//         yPos += 0.4;
//       }

//       // Summary
//       if (summary) {
//         s.addShape(pptx.ShapeType.roundRect, { x: 0.5, y: yPos, w: 12.3, h: 0.6, fill: { color: 'FAFAFA' }, rectRadius: 0.06 });
//         s.addText(summary, { x: 0.7, y: yPos + 0.05, w: 11.9, h: 0.5, fontSize: 9, italic: true, color: LIGHT, fontFace: 'Helvetica' });
//       }

//       // Footer
//       s.addShape(pptx.ShapeType.rect, { x: 0, y: 7.2, w: '100%', h: 0.3, fill: { color: BG } });
//       s.addText('GoToMarket Compliance Lab  •  Confidential', { x: 0.6, y: 7.22, w: 12, h: 0.26, fontSize: 7, color: LIGHT, fontFace: 'Helvetica' });
//     }

//     // ============ SLIDE 2: Ingredient Risk ============
//     const ir = d.ingredientRisk;
//     addSectionSlide('🧪', cn ? 'Ingredient Risk Overview' : 'Ingredient Risk Overview',
//       `${ir.flagCount} Flags`, ir.status, ir.items, 'name', 'note', ir.summary, ir.riskPercent, 'Risk Level');

//     // ============ SLIDE 3: Label Compliance ============
//     const lc = d.labelCompliance;
//     addSectionSlide('🏷️', cn ? 'Label Compliance Review' : 'Label Compliance Review',
//       `${lc.passCount}/${lc.totalCount} Pass`, lc.status, lc.items, 'name', 'note', lc.summary);

//     // ============ SLIDE 4: Facility Registration ============
//     const fr = d.facilityRegistration;
//     addSectionSlide('🏭', cn ? 'Facility Registration Status' : 'Facility Registration Status',
//       'Status', fr.status, fr.items, 'name', 'value', fr.summary);

//     // ============ SLIDE 5: Marketing Claims ============
//     const mc = d.marketingClaims;
//     addSectionSlide('💬', cn ? 'Marketing Claim Risk Review' : 'Marketing Claim Risk Review',
//       `${mc.issueCount} Issues`, mc.status, mc.items, 'claim', 'note', mc.summary, mc.riskPercent, 'Claim Risk');

//     // ============ SLIDE 6: Recommendations ============
//     const recs = cn ? (d.recommendationsCn || d.recommendations) : d.recommendations;
//     if (recs && recs.length) {
//       const s6 = pptx.addSlide();
//       s6.background = { fill: WHITE };
//       s6.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.06, fill: { color: ACCENT } });
//       s6.addShape(pptx.ShapeType.roundRect, { x: 0.5, y: 0.4, w: 12.3, h: 0.6, fill: { color: 'FFF8E1' }, rectRadius: 0.06 });
//       s6.addText('📋  Recommendations', { x: 0.7, y: 0.42, w: 8, h: 0.55, fontSize: 16, bold: true, color: '92400E', fontFace: 'Helvetica' });

//       recs.forEach((r, i) => {
//         const yy = 1.4 + i * 0.55;
//         s6.addText('→', { x: 0.7, y: yy, w: 0.4, h: 0.45, fontSize: 14, bold: true, color: WARN, fontFace: 'Helvetica' });
//         s6.addText(r, { x: 1.15, y: yy, w: 11.3, h: 0.45, fontSize: 11, color: '78350F', fontFace: 'Helvetica', valign: 'middle' });
//       });

//       s6.addShape(pptx.ShapeType.rect, { x: 0, y: 7.2, w: '100%', h: 0.3, fill: { color: BG } });
//       s6.addText('GoToMarket Compliance Lab  •  Confidential', { x: 0.6, y: 7.22, w: 12, h: 0.26, fontSize: 7, color: LIGHT, fontFace: 'Helvetica' });
//     }

//     // ============ SLIDE 7: Disclaimer ============
//     const s7 = pptx.addSlide();
//     s7.background = { fill: WHITE };
//     s7.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.06, fill: { color: ACCENT } });
//     s7.addText('Important Disclaimer', { x: 0.6, y: 0.5, w: 8, h: 0.6, fontSize: 20, bold: true, color: DARK, fontFace: 'Helvetica' });
//     s7.addText('FDA Registration & Compliance', { x: 0.6, y: 1.1, w: 8, h: 0.4, fontSize: 12, color: ACCENT, fontFace: 'Helvetica' });

//     const disclaimerPoints = [
//       'FDA does not approve individual dietary supplement or food products.',
//       'Registration applies to manufacturing facilities, not SKUs or brands.',
//       'No "FDA product certification" exists for supplements.',
//       'Key compliance factors: ingredient legality, proper labeling, valid facility registration, compliant marketing claims.',
//       'This report is AI-generated for reference only. Consult licensed regulatory professionals for final compliance confirmation.'
//     ];
//     disclaimerPoints.forEach((p, i) => {
//       s7.addText('•', { x: 0.7, y: 1.8 + i * 0.6, w: 0.3, h: 0.5, fontSize: 12, color: ACCENT, fontFace: 'Helvetica' });
//       s7.addText(p, { x: 1.05, y: 1.8 + i * 0.6, w: 11.3, h: 0.5, fontSize: 11, color: MID, fontFace: 'Helvetica', valign: 'middle' });
//     });

//     // Branding footer
//     s7.addShape(pptx.ShapeType.rect, { x: 0, y: 5.8, w: '100%', h: 1.7, fill: { color: ACCENT } });
//     s7.addText('GoToMarket Compliance Lab', { x: 0.6, y: 5.95, w: 8, h: 0.5, fontSize: 18, bold: true, color: WHITE, fontFace: 'Helvetica' });
//     s7.addText('Global Regulatory & Market Entry Intelligence Platform', { x: 0.6, y: 6.4, w: 8, h: 0.35, fontSize: 10, color: 'B0E8D8', fontFace: 'Helvetica' });
//     s7.addText(`© ${now.getFullYear()} GoToMarket Compliance Lab. All rights reserved.`, { x: 0.6, y: 6.9, w: 8, h: 0.3, fontSize: 8, color: 'B0E8D8', fontFace: 'Helvetica' });

//     // Generate and send
//     const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' });
//     const filename = `GoToMarket_Compliance_Report_${now.toISOString().split('T')[0]}.pptx`;

//     res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
//     res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
//     res.send(Buffer.from(pptxBuffer));

//   } catch (err) {
//     console.error('Slides generation error:', err);
//     res.status(500).json({ error: err.message || 'Failed to generate slides' });
//   }
// });

// --- Demo Data ---
function getDemoData(lang) {
  return {
    ingredientRisk: {
      status: "warn",
      flagCount: 3,
      items: [
        {
          name: "Sodium Benzoate (E211)",
          nameCn: "苯甲酸钠 (E211)",
          status: "pass",
          note: "FDA-affirmed GRAS preservative per 21 CFR 184.1733",
        },
        {
          name: "Red No. 40 (Allura Red)",
          nameCn: "诱惑红40号",
          status: "warn",
          note: "Requires specific listing on label per 21 CFR 74",
        },
        {
          name: "Steviol Glycosides",
          nameCn: "甜菊糖苷",
          status: "pass",
          note: "GRAS approved sweetener",
        },
        {
          name: "Titanium Dioxide (E171)",
          nameCn: "二氧化钛 (E171)",
          status: "fail",
          note: "Subject to ongoing regulatory review — requires verification of current guidance",
        },
      ],
      overallRisk: "medium",
      riskPercent: 55,
      summary:
        lang === "cn"
          ? "检测到 3 项需关注的成分标记，整体风险等级为中等。"
          : "3 ingredient flags detected. Overall risk level is medium.",
    },
    labelCompliance: {
      status: "warn",
      passCount: 7,
      totalCount: 9,
      items: [
        {
          name: "Nutrition Facts Format (2020)",
          nameCn: "营养成分表格式 (2020)",
          status: "pass",
          note: "Compliant",
        },
        {
          name: "Allergen Declaration (FALCPA)",
          nameCn: "过敏原声明 (FALCPA)",
          status: "warn",
          note: "Wheat allergen needs bold or separate Contains line",
        },
        {
          name: "Net Weight (Dual Units)",
          nameCn: "净含量（双单位）",
          status: "fail",
          note: "Missing US customary units (oz)",
        },
        {
          name: "Country of Origin",
          nameCn: "原产国标注",
          status: "pass",
          note: "Clearly displayed",
        },
        {
          name: "English Product Name",
          nameCn: "英文产品名称",
          status: "pass",
          note: "Present and legible",
        },
      ],
      summary:
        lang === "cn"
          ? "9 项标签检查中 7 项通过，2 项需修正。"
          : "7 of 9 label checks passed. 2 items need correction.",
    },
    facilityRegistration: {
      status: "info",
      items: [
        {
          name: "FDA Registration Number",
          nameCn: "FDA 注册编号",
          value: "Not provided",
          status: "info",
        },
        {
          name: "Registration Status",
          nameCn: "注册状态",
          value: "Needs verification",
          status: "info",
        },
        {
          name: "US Agent Designated",
          nameCn: "美国代理人",
          value: "Unknown",
          status: "warn",
        },
        {
          name: "FSVP Importer",
          nameCn: "FSVP 进口商",
          value: "Pending",
          status: "warn",
        },
      ],
      summary:
        lang === "cn"
          ? "工厂注册信息需要手动提供以完成验证。"
          : "Facility registration details need to be provided for verification.",
    },
    marketingClaims: {
      status: "warn",
      issueCount: 2,
      items: [
        {
          claim: '"All Natural"',
          claimCn: '"纯天然"',
          status: "warn",
          note: "Vague claim — FDA has no formal definition",
        },
        {
          claim: '"Boosts Immunity"',
          claimCn: '"增强免疫力"',
          status: "fail",
          note: "Requires review — health-related claim warrants regulatory assessment per DSHEA",
        },
        {
          claim: '"Low Sugar"',
          claimCn: '"低糖"',
          status: "pass",
          note: "Meets nutrient content claim criteria",
        },
        {
          claim: '"Non-GMO"',
          claimCn: '"非转基因"',
          status: "info",
          note: "Requires third-party certification",
        },
      ],
      riskLevel: "high",
      riskPercent: 72,
      summary:
        lang === "cn"
          ? "发现 2 项宣传语言问题，风险等级较高。"
          : "2 marketing claim issues found. Risk level is high.",
    },
    overallRiskLevel: "medium",
    overallVerdict:
      "Medium structural risk identified. Multiple items require optimization prior to U.S. market entry.",
    overallVerdictCn:
      "识别到中等结构风险。多项内容需在进入美国市场前进行优化。",
    recommendations: [
      "Add U.S. customary weight units (oz) per 21 CFR 101.105",
      'Add allergen "Contains" statement or bold declaration per FALCPA Sec. 203',
      'Review and revise health-related marketing claim "Boosts Immunity" per DSHEA Sec. 403(r)(6)',
      'Clarify or revise "All Natural" claim per FD&C Act Sec. 403(a)(1)',
      "Confirm facility FEI number and DUNS with manufacturer per 21 CFR 1.225",
    ],
    recommendationsCn: [
      "依据 21 CFR 101.105 添加美制重量单位 (oz)",
      '依据 FALCPA Sec. 203 添加过敏原"含有"声明或加粗标注',
      '依据 DSHEA Sec. 403(r)(6) 审查并修订健康相关宣传语"增强免疫力"',
      '依据 FD&C Act Sec. 403(a)(1) 明确或修订"纯天然"声称',
      "依据 21 CFR 1.225 与工厂确认设施 FEI 编号及 DUNS 信息",
    ],
  };
}

// --- Fallback to index.html ---
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- Start ---
app.listen(PORT, async () => {
  console.log(`✅ GoToMarket Compliance Lab running on port ${PORT}`);
  console.log(
    `   Gemini API: ${process.env.GEMINI_API_KEY ? "Configured ✓" : "Not configured (demo mode)"}`,
  );
  if (process.env.DATABASE_URL) {
    await initDB();
  } else {
    console.log(
      "   Database: Not configured (set DATABASE_URL for user accounts)",
    );
  }
});
