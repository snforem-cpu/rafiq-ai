const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://snforem-cpu.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};

/* =========================
   Gemini
========================= */

const GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite"
];

const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

/* =========================
   Exa
========================= */

const EXA_API_URL =
  "https://api.exa.ai/search";

/* =========================
   Firebase
========================= */

const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const firebaseKeyCache = new Map();

/* =========================
   Helpers
========================= */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      ...CORS_HEADERS
    }
  });
}

function nowISO() {
  return new Date().toISOString();
}

function base64UrlToBytes(value) {
  const normalized =
    String(value || "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");

  const padding =
    "=".repeat(
      (4 - normalized.length % 4) % 4
    );

  const binary =
    atob(normalized + padding);

  const bytes =
    new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] =
      binary.charCodeAt(i);
  }

  return bytes;
}

function base64UrlDecode(value) {
  return new TextDecoder().decode(
    base64UrlToBytes(value)
  );
}

function parseJwt(token) {
  const parts =
    String(token || "").split(".");

  if (parts.length !== 3) {
    return null;
  }

  try {
    return {
      header:
        JSON.parse(
          base64UrlDecode(parts[0])
        ),

      payload:
        JSON.parse(
          base64UrlDecode(parts[1])
        ),

      signingInput:
        `${parts[0]}.${parts[1]}`,

      signature:
        base64UrlToBytes(parts[2])
    };
  } catch {
    return null;
  }
}

/* =========================
   Database
========================= */

async function ensureDatabase(db) {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      )
    `),

    db.prepare(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),

    db.prepare(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `),

    db.prepare(`
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        due_at TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        recurrence TEXT,
        completed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `)
  ]);
}

/* =========================
   Users
========================= */

async function saveUser(db, userId) {
  await db.prepare(`
    INSERT OR IGNORE INTO users
    (id, created_at)
    VALUES (?, ?)
  `).bind(
    userId,
    nowISO()
  ).run();
}

/* =========================
   Conversations
========================= */

async function saveConversation(
  db,
  conversationId,
  userId,
  title = "محادثة جديدة"
) {
  const now = nowISO();

  await db.prepare(`
    INSERT OR IGNORE INTO conversations
    (id, user_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    conversationId,
    userId,
    title,
    now,
    now
  ).run();

  await db.prepare(`
    UPDATE conversations
    SET updated_at = ?
    WHERE id = ?
      AND user_id = ?
  `).bind(
    now,
    conversationId,
    userId
  ).run();
}

async function updateConversationTitle(
  db,
  conversationId,
  userId,
  message
) {
  const title =
    String(message || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);

  if (!title) {
    return;
  }

  await db.prepare(`
    UPDATE conversations
    SET title = ?
    WHERE id = ?
      AND user_id = ?
      AND (
        title IS NULL
        OR title = ''
        OR title = 'محادثة جديدة'
      )
  `).bind(
    title,
    conversationId,
    userId
  ).run();
}

async function listConversations(
  db,
  userId
) {
  const result = await db.prepare(`
    SELECT id, title, created_at, updated_at
    FROM conversations
    WHERE user_id = ?
    ORDER BY updated_at DESC
    LIMIT 100
  `).bind(
    userId
  ).all();

  return result.results || [];
}

async function deleteConversation(
  db,
  userId,
  conversationId
) {
  await db.batch([
    db.prepare(`
      DELETE FROM messages
      WHERE conversation_id = ?
        AND user_id = ?
    `).bind(
      conversationId,
      userId
    ),

    db.prepare(`
      DELETE FROM conversations
      WHERE id = ?
        AND user_id = ?
    `).bind(
      conversationId,
      userId
    )
  ]);
}

async function saveMessage(
  db,
  conversationId,
  userId,
  role,
  content
) {
  await db.prepare(`
    INSERT INTO messages
    (conversation_id, user_id, role, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    conversationId,
    userId,
    role,
    content,
    nowISO()
  ).run();
}

async function getConversationHistory(
  db,
  conversationId,
  userId,
  limit = 30
) {
  const result = await db.prepare(`
    SELECT role, content
    FROM messages
    WHERE conversation_id = ?
      AND user_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).bind(
    conversationId,
    userId,
    limit
  ).all();

  return (result.results || []).reverse();
}

/* =========================
   Memories
========================= */

async function getUserMemories(
  db,
  userId
) {
  const result = await db.prepare(`
    SELECT id,
           category,
           content,
           importance,
           source,
           confirmed,
           active,
           created_at
    FROM memories
    WHERE user_id = ?
      AND active = 1
    ORDER BY id DESC
    LIMIT 100
  `).bind(
    userId
  ).all();

  return result.results || [];
}

async function saveMemory(
  db,
  userId,
  memory,
  category = "general",
  importance = 3,
  source = "conversation",
  confirmed = 0
) {
  const clean =
    String(memory || "").trim();

  if (!clean) {
    return;
  }

  await db.prepare(`
    INSERT INTO memories
    (
      user_id,
      category,
      content,
      importance,
      source,
      confirmed,
      active,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    userId,
    category,
    clean,
    Number(importance) || 3,
    source,
    confirmed ? 1 : 0,
    1,
    nowISO()
  ).run();
}

async function deleteMemory(
  db,
  userId,
  memoryId
) {
  await db.prepare(`
    UPDATE memories
    SET active = 0
    WHERE id = ?
      AND user_id = ?
  `).bind(
    Number(memoryId),
    userId
  ).run();
}

/*
  نحفظ فقط الذكريات التي يطلب المستخدم
  حفظها بوضوح، وليس كل جملة عابرة.
*/

function extractExplicitMemory(message) {
  const text =
    String(message || "").trim();

  const patterns = [
    /^تذكر أن\s+(.+)$/i,
    /^تذكّر أن\s+(.+)$/i,
    /^تذكر بأن\s+(.+)$/i,
    /^تذكّر بأن\s+(.+)$/i,
    /^احفظ أن\s+(.+)$/i,
    /^احفظ بأن\s+(.+)$/i,
    /^لا تنس أن\s+(.+)$/i,
    /^لا تنسى أن\s+(.+)$/i,
    /^remember that\s+(.+)$/i,
    /^remember:\s*(.+)$/i
  ];

  for (const pattern of patterns) {
    const match =
      text.match(pattern);

    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return null;
}

/* =========================
   Firebase Authentication
========================= */

/*
  التحقق الكامل من Firebase ID Token:
  1. Header alg = RS256
  2. kid موجود
  3. التحقق من التوقيع بالمفتاح العام
  4. aud = Firebase project ID
  5. iss = https://securetoken.google.com/<projectId>
  6. exp / iat / auth_time
  7. sub غير فارغ

  مفاتيح Google العامة تأتي من JWKS
  ويتم تخزينها مؤقتًا في ذاكرة Worker.
*/

async function getFirebasePublicKey(
  kid
) {
  if (!kid) {
    throw new Error(
      "Firebase token لا يحتوي على kid."
    );
  }

  const cached =
    firebaseKeyCache.get(kid);

  if (
    cached &&
    cached.expiresAt > Date.now()
  ) {
    return cached.key;
  }

  const response =
    await fetch(
      FIREBASE_JWKS_URL,
      {
        headers: {
          "Accept":
            "application/json"
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      "تعذر الحصول على مفاتيح Firebase العامة."
    );
  }

  const data =
    await response.json();

  const cacheControl =
    response.headers.get(
      "Cache-Control"
    ) || "";

  const maxAgeMatch =
    cacheControl.match(
      /max-age=(\d+)/
    );

  const maxAge =
    maxAgeMatch
      ? Number(maxAgeMatch[1])
      : 3600;

  const expiresAt =
    Date.now() +
    Math.max(
      60,
      Math.min(
        maxAge,
        86400
      )
    ) * 1000;

  const keys =
    Array.isArray(data?.keys)
      ? data.keys
      : [];

  /*
    إذا تغيرت المفاتيح، امسح
    الكاش القديم ثم أعد التخزين.
  */

  firebaseKeyCache.clear();

  for (const jwk of keys) {
    if (
      jwk?.kid &&
      jwk?.kty === "RSA" &&
      jwk?.alg === "RS256"
    ) {
      try {
        const cryptoKey =
          await crypto.subtle.importKey(
            "jwk",
            jwk,
            {
              name:
                "RSASSA-PKCS1-v1_5",
              hash:
                "SHA-256"
            },
            false,
            ["verify"]
          );

        firebaseKeyCache.set(
          jwk.kid,
          {
            key:
              cryptoKey,
            expiresAt
          }
        );
      } catch (error) {
        console.error(
          "Firebase key import failed:",
          jwk.kid,
          error
        );
      }
    }
  }

  const result =
    firebaseKeyCache.get(kid);

  if (!result) {
    throw new Error(
      "مفتاح Firebase المطلوب غير موجود."
    );
  }

  return result.key;
}

async function verifyFirebaseToken(
  token,
  env
) {
  const parsed =
    parseJwt(token);

  if (!parsed) {
    throw new Error(
      "Firebase ID Token غير صالح."
    );
  }

  const {
    header,
    payload,
    signingInput,
    signature
  } = parsed;

  if (
    header.alg !== "RS256"
  ) {
    throw new Error(
      "خوارزمية Firebase Token غير صالحة."
    );
  }

  if (!header.kid) {
    throw new Error(
      "Firebase Token لا يحتوي على kid."
    );
  }

  const projectId =
    String(
      env.FIREBASE_PROJECT_ID || ""
    ).trim();

  if (!projectId) {
    throw new Error(
      "FIREBASE_PROJECT_ID غير موجود في Worker."
    );
  }

  const issuer =
    `https://securetoken.google.com/${projectId}`;

  const now =
    Math.floor(
      Date.now() / 1000
    );

  const exp =
    Number(payload.exp);

  const iat =
    Number(payload.iat);

  const authTime =
    Number(payload.auth_time);

  if (
    payload.aud !== projectId
  ) {
    throw new Error(
      "Firebase Token لا ينتمي إلى المشروع الصحيح."
    );
  }

  if (
    payload.iss !== issuer
  ) {
    throw new Error(
      "Firebase Token له issuer غير صحيح."
    );
  }

  if (
    !payload.sub ||
    typeof payload.sub !== "string"
  ) {
    throw new Error(
      "Firebase Token لا يحتوي على uid صالح."
    );
  }

  if (
    !Number.isFinite(exp) ||
    exp <= now
  ) {
    throw new Error(
      "Firebase Token منتهي الصلاحية."
    );
  }

  if (
    !Number.isFinite(iat) ||
    iat > now + 60
  ) {
    throw new Error(
      "وقت إصدار Firebase Token غير صالح."
    );
  }

  if (
    !Number.isFinite(authTime) ||
    authTime > now + 60
  ) {
    throw new Error(
      "وقت مصادقة Firebase Token غير صالح."
    );
  }

  const key =
    await getFirebasePublicKey(
      header.kid
    );

  const valid =
    await crypto.subtle.verify(
      {
        name:
          "RSASSA-PKCS1-v1_5"
      },
      key,
      signature,
      new TextEncoder().encode(
        signingInput
      )
    );

  if (!valid) {
    throw new Error(
      "توقيع Firebase Token غير صالح."
    );
  }

  return {
    uid:
      String(payload.sub),

    email:
      payload.email
        ? String(payload.email)
        : "",

    emailVerified:
      Boolean(payload.email_verified),

    payload
  };
}

/*
  يدعم Authorization: Bearer TOKEN
  ويدعم firebase_token داخل JSON.

  السبب: الواجهة الحالية تمر عبر
  Google Apps Script، وCode.gs الحالي
  لا يمرر Authorization header.
*/

async function getFirebaseUser(
  request,
  env,
  body = {}
) {
  const authorization =
    request.headers.get(
      "Authorization"
    ) || "";

  let token = "";

  if (
    authorization.startsWith(
      "Bearer "
    )
  ) {
    token =
      authorization
        .slice(7)
        .trim();
  }

  if (!token && body.firebase_token) {
    token =
      String(
        body.firebase_token
      ).trim();
  }

  if (!token) {
    return null;
  }

  return await verifyFirebaseToken(
    token,
    env
  );
}

/*
  توافق مؤقت مع الواجهة القديمة.
  بمجرد انتقال Index.html النهائي إلى
  Firebase Token، لن تعتمد الواجهة على
  user_id لتحديد الهوية.
*/

async function getFirebaseUserId(
  request,
  env,
  body = {}
) {
  const firebaseUser =
    await getFirebaseUser(
      request,
      env,
      body
    );

  if (firebaseUser) {
    return firebaseUser.uid;
  }

  /*
    هذه فقط للحفاظ على عمل النسخة
    الحالية أثناء الانتقال إلى الواجهة
    النهائية.
  */

  return String(
    body.user_id || ""
  ).trim();
}

/* =========================
   Web Search - Exa
========================= */

function shouldSearchWeb(message) {
  const text =
    String(message || "")
      .toLowerCase();

  const patterns = [
    "اليوم",
    "الآن",
    "حاليًا",
    "حاليا",
    "اخر",
    "آخر",
    "أحدث",
    "حديث",
    "خبر",
    "أخبار",
    "سعر",
    "أسعار",
    "موعد",
    "متى",
    "طقس",
    "الطقس",
    "نتيجة",
    "نتائج",
    "2026",
    "2025",
    "today",
    "now",
    "latest",
    "current",
    "recent",
    "news",
    "price",
    "prices",
    "weather",
    "score",
    "scores",
    "when",
    "who is",
    "what happened"
  ];

  return patterns.some(
    pattern =>
      text.includes(pattern)
  );
}

async function searchExa(
  env,
  query
) {
  if (!env.EXA_API_KEY) {
    return [];
  }

  const response =
    await fetch(
      EXA_API_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "x-api-key":
            env.EXA_API_KEY
        },

        body:
          JSON.stringify({
            query,
            type: "auto",
            numResults: 5,

            contents: {
              highlights: {
                maxCharacters: 1200
              }
            }
          })
      }
    );

  const raw =
    await response.text();

  if (!response.ok) {
    console.error(
      "Exa error:",
      response.status,
      raw
    );

    return [];
  }

  let data;

  try {
    data =
      JSON.parse(raw);
  } catch {
    return [];
  }

  return (data.results || [])
    .map(item => ({
      title:
        item.title || "",

      url:
        item.url || "",

      publishedDate:
        item.publishedDate || "",

      highlights:
        Array.isArray(
          item.highlights
        )
          ? item.highlights
          : []
    }))
    .filter(
      item => item.url
    );
}

/* =========================
   System Instruction
========================= */

function buildSystemInstruction(
  memories,
  webResults = []
) {
  let memoryText =
    "لا توجد معلومات محفوظة عن المستخدم حتى الآن.";

  if (memories.length > 0) {
    memoryText =
      memories
        .map(item => {
          const category =
            item.category
              ? ` [${item.category}]`
              : "";

          return `- ${item.content}${category}`;
        })
        .join("\n");
  }

  let webText =
    "لم يتم إجراء بحث ويب لهذا الطلب.";

  if (webResults.length > 0) {
    webText =
      webResults
        .map((item, index) => {
          const highlights =
            item.highlights.length
              ? item.highlights.join(" ")
              : "";

          return `
[${index + 1}]
العنوان: ${item.title}
الرابط: ${item.url}
التاريخ: ${item.publishedDate || "غير متوفر"}
المقتطف: ${highlights}
`;
        })
        .join("\n");
  }

  return `
أنت رفيق AI، مساعد شخصي ذكي للمستخدم.

هويتك الثابتة:
- اسمك: رفيق
- وصفك: "أنا رفيق، مساعدك الشخصي بالذكاء الاصطناعي"
- إذا سألك المستخدم: "من صنعك؟" أو "من قام بصنعك؟"
  أجب: "شركة أكسون (Axon)."

قواعد مهمة:
- كن مفيدًا ودقيقًا وواضحًا.
- استخدم سياق المحادثة السابقة عندما يكون مفيدًا.
- استخدم المعلومات المحفوظة عن المستخدم لتقديم إجابات أكثر تخصيصًا.
- لا تدّعِ أنك تملك معلومات لا تملكها.
- لا تكشف مفاتيح API أو الأسرار أو تفاصيل البنية الداخلية.
- إذا لم تعرف شيئًا، قل ذلك بوضوح.
- لا تكرر إجابة المستخدم بلا فائدة.
- تعامل مع المعلومات المحفوظة عن المستخدم كسياق مساعد، وليس كحقيقة مطلقة إذا تعارضت مع كلامه الحالي.
- لا تدّعِ أنك نفذت إجراءً خارجيًا إذا لم ينفذه النظام فعليًا.

البحث على الويب:
- إذا كانت نتائج البحث مرفقة، استخدمها للمعلومات الحديثة.
- لا تخترع مصادر أو روابط.
- عند استخدام نتائج البحث، اذكر المصادر بوضوح.
- ميّز بين المعلومات المؤكدة والاستنتاج.
- إذا كانت المصادر متعارضة، وضح ذلك بدل اختراع إجابة.

المعلومات المحفوظة عن المستخدم:
${memoryText}

نتائج البحث الحالية:
${webText}
`;
}

/* =========================
   Gemini
========================= */

function isRetryableGeminiStatus(
  status
) {
  return [
    408,
    429,
    500,
    502,
    503,
    504
  ].includes(status);
}

async function callGeminiModel(
  env,
  model,
  payload
) {
  const url =
    `${GEMINI_API_BASE}/${model}:generateContent`;

  const response =
    await fetch(
      url,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "x-goog-api-key":
            env.GEMINI_API_KEY
        },

        body:
          JSON.stringify(payload)
      }
    );

  const raw =
    await response.text();

  if (!response.ok) {
    const error =
      new Error(
        `Gemini API ${response.status}: ${raw}`
      );

    error.status =
      response.status;

    throw error;
  }

  let data;

  try {
    data =
      JSON.parse(raw);
  } catch {
    throw new Error(
      "Gemini أعاد استجابة غير صالحة."
    );
  }

  const reply =
    data?.candidates?.[0]?.content?.parts
      ?.map(
        part => part.text || ""
      )
      .join("")
      .trim();

  if (!reply) {
    throw new Error(
      "Gemini لم يُرجع نصًا."
    );
  }

  return reply;
}

async function callGemini(
  env,
  history,
  memories,
  userMessage,
  webResults = []
) {
  if (!env.GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY غير موجود في Worker."
    );
  }

  const contents = [];

  for (const item of history) {
    contents.push({
      role:
        item.role === "assistant"
          ? "model"
          : "user",

      parts: [
        {
          text:
            item.content
        }
      ]
    });
  }

  contents.push({
    role: "user",

    parts: [
      {
        text:
          userMessage
      }
    ]
  });

  const payload = {
    system_instruction: {
      parts: [
        {
          text:
            buildSystemInstruction(
              memories,
              webResults
            )
        }
      ]
    },

    contents,

    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 4096
    }
  };

  let lastError = null;

  for (
    let i = 0;
    i < GEMINI_MODELS.length;
    i++
  ) {
    const model =
      GEMINI_MODELS[i];

    try {
      console.log(
        `Gemini محاولة ${i + 1}/${GEMINI_MODELS.length}: ${model}`
      );

      const reply =
        await callGeminiModel(
          env,
          model,
          payload
        );

      console.log(
        `Gemini نجح باستخدام: ${model}`
      );

      return reply;

    } catch (error) {
      lastError =
        error;

      const status =
        Number(
          error?.status || 0
        );

      console.error(
        `Gemini فشل باستخدام ${model}. الحالة: ${status}`,
        error
      );

      if (
        !isRetryableGeminiStatus(
          status
        )
      ) {
        throw error;
      }
    }
  }

  if (lastError) {
    throw new Error(
      "جميع نماذج Gemini المتاحة مشغولة أو غير متاحة مؤقتًا. حاول مرة أخرى بعد قليل."
    );
  }

  throw new Error(
    "حدث خطأ أثناء الاتصال بالذكاء الاصطناعي."
  );
}

/* =========================
   Chat
========================= */

async function handleChat(
  request,
  env,
  body
) {
  if (!env.DB) {
    return json({
      ok: false,
      error:
        "D1 binding DB غير موجود."
    }, 500);
  }

  await ensureDatabase(
    env.DB
  );

  const userId =
    await getFirebaseUserId(
      request,
      env,
      body
    );

  const conversationId =
    String(
      body.conversation_id ||
      crypto.randomUUID()
    ).trim();

  const message =
    String(
      body.message || ""
    ).trim();

  if (!userId) {
    return json({
      ok: false,
      error:
        "تسجيل الدخول مطلوب."
    }, 401);
  }

  if (!message) {
    return json({
      ok: false,
      error:
        "message مطلوب."
    }, 400);
  }

  await saveUser(
    env.DB,
    userId
  );

  await saveConversation(
    env.DB,
    conversationId,
    userId
  );

  const history =
    await getConversationHistory(
      env.DB,
      conversationId,
      userId,
      30
    );

  const memories =
    await getUserMemories(
      env.DB,
      userId
    );

  /*
    إذا طلب المستخدم صراحة حفظ معلومة،
    نحفظها تلقائيًا.
  */

  const explicitMemory =
    extractExplicitMemory(
      message
    );

  if (explicitMemory) {
    try {
      await saveMemory(
        env.DB,
        userId,
        explicitMemory,
        "general",
        4,
        "conversation",
        1
      );
    } catch (error) {
      console.error(
        "Automatic memory save failed:",
        error
      );
    }
  }

  let webResults = [];

  if (
    shouldSearchWeb(message) &&
    env.EXA_API_KEY
  ) {
    try {
      webResults =
        await searchExa(
          env,
          message
        );
    } catch (error) {
      console.error(
        "Exa search failed:",
        error
      );
    }
  }

  await saveMessage(
    env.DB,
    conversationId,
    userId,
    "user",
    message
  );

  await updateConversationTitle(
    env.DB,
    conversationId,
    userId,
    message
  );

  let reply;

  try {
    reply =
      await callGemini(
        env,
        history,
        memories,
        message,
        webResults
      );
  } catch (error) {
    console.error(
      "Gemini error:",
      error
    );

    return json({
      ok: false,
      error:
        error?.message ||
        "حدث خطأ أثناء الاتصال بالذكاء الاصطناعي."
    }, 500);
  }

  await saveMessage(
    env.DB,
    conversationId,
    userId,
    "assistant",
    reply
  );

  return json({
    ok: true,
    reply,
    conversation_id:
      conversationId,

    sources:
      webResults.map(item => ({
        title:
          item.title,

        url:
          item.url,

        publishedDate:
          item.publishedDate
      }))
  });
}

/* =========================
   Memories API
========================= */

async function handleGetMemories(
  request,
  env,
  body
) {
  if (!env.DB) {
    return json({
      ok: false,
      error:
        "D1 binding DB غير موجود."
    }, 500);
  }

  await ensureDatabase(
    env.DB
  );

  const userId =
    await getFirebaseUserId(
      request,
      env,
      body
    );

  if (!userId) {
    return json({
      ok: false,
      error:
        "تسجيل الدخول مطلوب."
    }, 401);
  }

  const memories =
    await getUserMemories(
      env.DB,
      userId
    );

  return json({
    ok: true,
    memories
  });
}

async function handleSaveMemory(
  request,
  env,
  body
) {
  if (!env.DB) {
    return json({
      ok: false,
      error:
        "D1 binding DB غير موجود."
    }, 500);
  }

  await ensureDatabase(
    env.DB
  );

  const userId =
    await getFirebaseUserId(
      request,
      env,
      body
    );

  const memory =
    String(
      body.memory ||
      body.content ||
      ""
    ).trim();

  if (!userId || !memory) {
    return json({
      ok: false,
      error:
        "المستخدم والذاكرة مطلوبان."
    }, 400);
  }

  await saveUser(
    env.DB,
    userId
  );

  await saveMemory(
    env.DB,
    userId,
    memory,
    body.category ||
      "general",
    body.importance ||
      3,
    body.source ||
      "user",
    body.confirmed ||
      0
  );

  return json({
    ok: true
  });
}

async function handleDeleteMemory(
  request,
  env,
  body
) {
  if (!env.DB) {
    return json({
      ok: false,
      error:
        "D1 binding DB غير موجود."
    }, 500);
  }

  await ensureDatabase(
    env.DB
  );

  const userId =
    await getFirebaseUserId(
      request,
      env,
      body
    );

  const memoryId =
    Number(
      body.memory_id
    );

  if (
    !userId ||
    !memoryId
  ) {
    return json({
      ok: false,
      error:
        "memory_id مطلوب."
    }, 400);
  }

  await deleteMemory(
    env.DB,
    userId,
    memoryId
  );

  return json({
    ok: true
  });
}

/* =========================
   Conversations API
========================= */

async function handleGetConversations(
  request,
  env,
  body
) {
  if (!env.DB) {
    return json({
      ok: false,
      error:
        "D1 binding DB غير موجود."
    }, 500);
  }

  await ensureDatabase(
    env.DB
  );

  const userId =
    await getFirebaseUserId(
      request,
      env,
      body
    );

  if (!userId) {
    return json({
      ok: false,
      error:
        "تسجيل الدخول مطلوب."
    }, 401);
  }

  const conversations =
    await listConversations(
      env.DB,
      userId
    );

  return json({
    ok: true,
    conversations
  });
}

async function handleDeleteConversation(
  request,
  env,
  body
) {
  if (!env.DB) {
    return json({
      ok: false,
      error:
        "D1 binding DB غير موجود."
    }, 500);
  }

  await ensureDatabase(
    env.DB
  );

  const userId =
    await getFirebaseUserId(
      request,
      env,
      body
    );

  const conversationId =
    String(
      body.conversation_id ||
      ""
    ).trim();

  if (
    !userId ||
    !conversationId
  ) {
    return json({
      ok: false,
      error:
        "المستخدم والمحادثة مطلوبان."
    }, 400);
  }

  await deleteConversation(
    env.DB,
    userId,
    conversationId
  );

  return json({
    ok: true
  });
}

/* =========================
   Reminders
========================= */

async function createReminder(
  db,
  userId,
  data
) {
  const id =
    String(
      data.id ||
      crypto.randomUUID()
    );

  const text =
    String(
      data.text || ""
    ).trim();

  const dueAt =
    String(
      data.due_at || ""
    ).trim();

  const timezone =
    String(
      data.timezone ||
      "UTC"
    ).trim();

  const recurrence =
    data.recurrence
      ? String(
          data.recurrence
        )
      : null;

  if (
    !text ||
    !dueAt
  ) {
    throw new Error(
      "نص التذكير وموعده مطلوبان."
    );
  }

  const dueDate =
    new Date(dueAt);

  if (
    Number.isNaN(
      dueDate.getTime()
    )
  ) {
    throw new Error(
      "موعد التذكير غير صالح."
    );
  }

  await db.prepare(`
    INSERT INTO reminders
    (
      id,
      user_id,
      text,
      due_at,
      timezone,
      recurrence,
      completed,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).bind(
    id,
    userId,
    text,
    dueDate.toISOString(),
    timezone,
    recurrence,
    nowISO()
  ).run();

  return id;
}

async function getReminders(
  db,
  userId
) {
  const result =
    await db.prepare(`
      SELECT id,
             text,
             due_at,
             timezone,
             recurrence,
             completed,
             created_at
      FROM reminders
      WHERE user_id = ?
      ORDER BY due_at ASC
      LIMIT 200
    `).bind(
      userId
    ).all();

  return result.results || [];
}

async function getDueReminders(
  db,
  userId
) {
  const result =
    await db.prepare(`
      SELECT id,
             text,
             due_at,
             timezone,
             recurrence,
             completed,
             created_at
      FROM reminders
      WHERE user_id = ?
        AND completed = 0
        AND due_at <= ?
      ORDER BY due_at ASC
      LIMIT 50
    `).bind(
      userId,
      nowISO()
    ).all();

  return result.results || [];
}

function getNextReminderDate(
  currentDueAt,
  recurrence
) {
  const current =
    new Date(
      currentDueAt
    );

  if (
    Number.isNaN(
      current.getTime()
    )
  ) {
    return null;
  }

  const value =
    String(
      recurrence || ""
    )
      .trim()
      .toLowerCase();

  /*
    قبول عدة صيغ حتى تكون الواجهة
    مرنة.
  */

  if (
    value === "daily" ||
    value === "يومي" ||
    value === "كل يوم"
  ) {
    current.setUTCDate(
      current.getUTCDate() + 1
    );

    return current.toISOString();
  }

  if (
    value === "weekly" ||
    value === "weekly" ||
    value === "أسبوعي" ||
    value === "كل أسبوع"
  ) {
    current.setUTCDate(
      current.getUTCDate() + 7
    );

    return current.toISOString();
  }

  if (
    value === "monthly" ||
    value === "شهري" ||
    value === "كل شهر"
  ) {
    current.setUTCMonth(
      current.getUTCMonth() + 1
    );

    return current.toISOString();
  }

  /*
    recurrence يمكن أن يكون JSON:
    {"type":"daily"}
    {"type":"weekly"}
    {"type":"monthly"}
  */

  try {
    const parsed =
      JSON.parse(
        value
      );

    if (
      parsed &&
      parsed.type
    ) {
      return getNextReminderDate(
        currentDueAt,
        parsed.type
      );
    }
  } catch {
    // ليس JSON، نكمل.
  }

  return null;
}

async function completeReminder(
  db,
  userId,
  reminderId
) {
  const result =
    await db.prepare(`
      SELECT id,
             due_at,
             recurrence
      FROM reminders
      WHERE id = ?
        AND user_id = ?
        AND completed = 0
      LIMIT 1
    `).bind(
      reminderId,
      userId
    ).first();

  if (!result) {
    return;
  }

  const nextDue =
    result.recurrence
      ? getNextReminderDate(
          result.due_at,
          result.recurrence
        )
      : null;

  if (nextDue) {
    await db.prepare(`
      UPDATE reminders
      SET due_at = ?,
          completed = 0
      WHERE id = ?
        AND user_id = ?
    `).bind(
      nextDue,
      reminderId,
      userId
    ).run();
  } else {
    await db.prepare(`
      UPDATE reminders
      SET completed = 1
      WHERE id = ?
        AND user_id = ?
    `).bind(
      reminderId,
      userId
    ).run();
  }
}

async function deleteReminder(
  db,
  userId,
  reminderId
) {
  await db.prepare(`
    DELETE FROM reminders
    WHERE id = ?
      AND user_id = ?
  `).bind(
    reminderId,
    userId
  ).run();
}

async function handleReminderAction(
  request,
  env,
  body
) {
  if (!env.DB) {
    return json({
      ok: false,
      error:
        "D1 binding DB غير موجود."
    }, 500);
  }

  await ensureDatabase(
    env.DB
  );

  const userId =
    await getFirebaseUserId(
      request,
      env,
      body
    );

  if (!userId) {
    return json({
      ok: false,
      error:
        "تسجيل الدخول مطلوب."
    }, 401);
  }

  const action =
    String(
      body.reminder_action ||
      ""
    ).trim();

  if (
    action === "create"
  ) {
    const id =
      await createReminder(
        env.DB,
        userId,
        body
      );

    return json({
      ok: true,
      reminder_id: id
    });
  }

  if (
    action === "list"
  ) {
    const reminders =
      await getReminders(
        env.DB,
        userId
      );

    return json({
      ok: true,
      reminders
    });
  }

  if (
    action === "due"
  ) {
    const reminders =
      await getDueReminders(
        env.DB,
        userId
      );

    return json({
      ok: true,
      reminders
    });
  }

  if (
    action === "complete"
  ) {
    await completeReminder(
      env.DB,
      userId,
      String(
        body.reminder_id
      )
    );

    return json({
      ok: true
    });
  }

  if (
    action === "delete"
  ) {
    await deleteReminder(
      env.DB,
      userId,
      String(
        body.reminder_id
      )
    );

    return json({
      ok: true
    });
  }

  return json({
    ok: false,
    error:
      "إجراء تذكير غير معروف."
  }, 400);
}

/* =========================
   Cron
========================= */

async function processReminders(
  env
) {
  if (!env.DB) {
    console.error(
      "Cron: D1 binding DB غير موجود."
    );

    return;
  }

  await ensureDatabase(
    env.DB
  );

  const result =
    await env.DB.prepare(`
      SELECT id,
             user_id,
             text,
             due_at,
             timezone,
             recurrence,
             completed
      FROM reminders
      WHERE completed = 0
        AND due_at <= ?
      ORDER BY due_at ASC
      LIMIT 100
    `).bind(
      nowISO()
    ).all();

  const reminders =
    result.results || [];

  /*
    Cron لا يغلق التذكير هنا.
    لأن إغلاقه قبل أن تعرضه الواجهة
    سيجعل الإشعار داخل التطبيق يضيع.

    الواجهة تستدعي action=due،
    تعرض الإشعار، ثم تستدعي complete.
  */

  for (const reminder of reminders) {
    console.log(
      "Reminder due:",
      reminder.id,
      reminder.user_id,
      reminder.text,
      reminder.due_at
    );
  }
}

/* =========================
   Worker
========================= */

export default {
  async fetch(
    request,
    env
  ) {
    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers:
            CORS_HEADERS
        }
      );
    }

    try {
      if (
        request.method ===
        "GET"
      ) {
        return json({
          ok: true,
          service: "Rafiq AI",
          status: "online",

          model:
            GEMINI_MODELS[0],

          fallback_models:
            GEMINI_MODELS.slice(1),

          features: {
            chat: true,
            memories: true,
            conversations: true,

            web_search:
              Boolean(
                env.EXA_API_KEY
              ),

            reminders: true,

            firebase:
              Boolean(
                env.FIREBASE_PROJECT_ID
              ),

            firebase_signature_verification:
              true
          }
        });
      }

      if (
        request.method !==
        "POST"
      ) {
        return json({
          ok: false,
          error:
            "Method not allowed"
        }, 405);
      }

      let body;

      try {
        body =
          await request
            .clone()
            .json();
      } catch {
        return json({
          ok: false,
          error:
            "Invalid JSON body."
        }, 400);
      }

      const action =
        String(
          body.action ||
          "chat"
        ).trim();

      if (
        action ===
        "chat"
      ) {
        return await handleChat(
          request,
          env,
          body
        );
      }

      if (
        action ===
        "get_memories"
      ) {
        return await handleGetMemories(
          request,
          env,
          body
        );
      }

      if (
        action ===
        "save_memory"
      ) {
        return await handleSaveMemory(
          request,
          env,
          body
        );
      }

      if (
        action ===
        "delete_memory"
      ) {
        return await handleDeleteMemory(
          request,
          env,
          body
        );
      }

      if (
        action ===
        "get_conversations"
      ) {
        return await handleGetConversations(
          request,
          env,
          body
        );
      }

      if (
        action ===
        "delete_conversation"
      ) {
        return await handleDeleteConversation(
          request,
          env,
          body
        );
      }

      if (
        action ===
        "reminder"
      ) {
        return await handleReminderAction(
          request,
          env,
          body
        );
      }

      return json({
        ok: false,
        error:
          `Unknown action: ${action}`
      }, 400);

    } catch (error) {
      console.error(
        "Worker error:",
        error
      );

      return json({
        ok: false,
        error:
          error?.message ||
          "Internal server error."
      }, 500);
    }
  },

  async scheduled(
    controller,
    env,
    ctx
  ) {
    ctx.waitUntil(
      processReminders(env)
    );
  }
};
