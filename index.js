require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// =====================================================
// FIREBASE
// =====================================================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// =====================================================
// GEMINI KEY ROTATOR
// =====================================================
const API_KEYS = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
    process.env.GEMINI_API_KEY_6,
    process.env.GEMINI_API_KEY_7,
    process.env.GEMINI_API_KEY_8
].filter(Boolean);

let keyIndex = 0;

function getNextKey() {
    const key = API_KEYS[keyIndex];
    keyIndex = (keyIndex + 1) % API_KEYS.length;
    return key;
}

// =====================================================
// GEMINI CALL
// =====================================================
async function callGemini(contents) {
    let lastError;

    for (let i = 0; i < API_KEYS.length; i++) {
        const key = getNextKey();

        try {
            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
                { contents },
                {
                    headers: { "Content-Type": "application/json" },
                    timeout: 45000
                }
            );

            const text =
                response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

            if (text) return text.trim();

        } catch (err) {
            lastError = err;
            console.error("Gemini key failed:", key.slice(0, 8));
        }
    }

    throw new Error(
        lastError?.response?.data?.error?.message ||
        lastError?.message ||
        "Gemini failed"
    );
}

// =====================================================
// OPTIONAL AUTH
// =====================================================
const optionalAuth = async (req, res, next) => {
    req.user = null;

    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return next();

    try {
        const token = header.split("Bearer ")[1];
        req.user = await admin.auth().verifyIdToken(token);
    } catch {
        req.user = null;
    }

    next();
};

// =====================================================
// UNICODE + CLEAN OUTPUT MODE (IMPORTANT)
// =====================================================
function buildSystemPrompt(prompt) {
    return `
You are JARVIS.

STRICT RULES:
- Do NOT use LaTeX ($ or $$)
- Do NOT use markdown (** or __)
- Use clean readable text only
- Use Unicode math symbols when needed:
  √ π ± × ÷ ∫ ∑ ∞ ² ³

STYLE:
- Simple
- Educational
- WhatsApp-style responses
- No formatting noise

User:
${prompt}
`;
}

// =====================================================
// CHAT ROUTE
// =====================================================
app.post("/chat", optionalAuth, async (req, res) => {
    try {
        const {
            prompt = "",
            attachmentUrl,
            attachmentType
        } = req.body;

        if (!prompt && !attachmentUrl) {
            return res.status(400).json({
                error: "Prompt or attachment required"
            });
        }

        const parts = [];

        // TEXT (wrapped in strict system rules)
        if (prompt.trim()) {
            parts.push({
                text: buildSystemPrompt(prompt)
            });
        }

        // IMAGE SUPPORT (Cloudinary)
        if (attachmentUrl) {

            if (attachmentType?.startsWith("image/")) {
                parts.push({
                    fileData: {
                        fileUri: attachmentUrl,
                        mimeType: attachmentType
                    }
                });
            } else {
                parts.push({
                    text: `File attached: ${attachmentUrl}`
                });
            }
        }

        // =====================================================
        // FIRESTORE MEMORY (AUTH USERS)
        // =====================================================
        if (req.user) {
            const uid = req.user.uid;

            const chatRef = db
                .collection("users")
                .doc(uid)
                .collection("history");

            const snapshot = await chatRef
                .orderBy("timestamp", "asc")
                .limitToLast(10)
                .get();

            const history = [];

            snapshot.forEach(doc => {
                const data = doc.data();
                if (data.content) history.push(data.content);
            });

            history.push({
                role: "user",
                parts
            });

            let reply = await callGemini(history);

            await chatRef.add({
                content: {
                    role: "user",
                    parts
                },
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            await chatRef.add({
                content: {
                    role: "model",
                    parts: [{ text: reply }]
                },
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            return res.json({
                reply,
                memory: true
            });
        }

        // =====================================================
        // GUEST MODE
        // =====================================================
        let reply = await callGemini([
            {
                role: "user",
                parts
            }
        ]);

        return res.json({
            reply,
            memory: false
        });

    } catch (err) {
        console.error("CHAT ERROR:", err);

        return res.status(500).json({
            error: "AI failed",
            details:
                process.env.NODE_ENV === "development"
                    ? err.message
                    : undefined
        });
    }
});

// =====================================================
// SERVER START
// =====================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("🚀 JARVIS CORE running on port", PORT);
});
