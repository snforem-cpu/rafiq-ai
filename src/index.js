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

/* =========================
   Firebase
   ========================= */

/*
  في المرحلة الحالية:
  - إذا أرسلت الواجهة Firebase ID Token
    نحاول التحقق منه.
  - إذا لم ترسله الواجهة بعد، نستمر مؤقتًا
    باستخدام user_id حتى لا يتعطل التطبيق
    قبل تحديث Index.html.

  لا يتم إرسال مفتاح Firebase أو أي سر
  إلى الواجهة.
*/

function base64UrlDecode(value) {
  const normalized =
    value.replace(/-/g, "+").replace(/_/g, "/");

  const padding =
    "=".repeat(
      (4 - normalized.length % 4) % 4
    );

  const binary =
    atob(normalized + padding);

  const bytes =
    Uint8Array.from(
      binary,
      char => char.charCodeAt(0)
    );

  return new TextDecoder().decode(bytes);
}

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");

  if (parts.length !== 3) {
    return null;
  }

  try {
    return JSON.parse(
      base64UrlDecode(parts[1])
    );
  } catch {
    return null;
  }
}

async function getFirebaseUserId(
  request,
  env,
  fallbackUserId = ""
) {
  const authorization =
    request.headers.get("Authorization") || "";

  if (
    authorization.startsWith("Bearer ")
  ) {
    const token =
      authorization.slice(7).trim();

    const payload =
      decodeJwtPayload(token);

    /*
      التحقق الكامل من توقيع Firebase
      يحتاج مفاتيح Google العامة.
      نحاول التحقق من issuer/audience
      أولًا، ثم نستخدم uid من token.

      عند تفعيل Firebase في الواجهة،
      سيكون هذا هو المسار الأساسي.
    */

    if (payload) {
      const projectId =
        String(
          env.FIREBASE_PROJECT_ID || ""
        ).trim();

      const issuer =
        `https://securetoken.google.com/${projectId}`;

      const validIssuer =
        !projectId ||
        payload.iss === issuer;

      const validAudience =
        !projectId ||
        payload.aud === projectId;

      const notExpired =
        !payload.exp ||
        Number(payload.exp) * 1000 > Date.now();

      if (
        validIssuer &&
        validAudience &&
        notExpired &&
        payload.user_id
      ) {
        return String(
          payload.user_id
        );
      }

      if (
        validIssuer &&
        validAudience &&
        notExpired &&
        payload.sub
      ) {
        return String(
          payload.sub
        );
      }
    }
  }

  /*
    توافق مؤقت مع الواجهة الحالية.
  */

  return String(
    fallbackUserId || ""
  ).trim();
}

/* =========================
   Web Search - Exa
========================= */

function shouldSearchWeb(message) {
  const text =
    String(message || "").toLowerCase();

  const patterns = [
    "اليوم",
    "الآن",
    "حاليًا",
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
    pattern => text.includes(pattern)
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
          "Content-Type": "application/json",
          "x-api-key": env.EXA_API_KEY
        },

        body: JSON.stringify({
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
        Array.isArray(item.highlights)
          ? item.highlights
          : []
    }))
    .filter(item => item.url);
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

البحث على الويب:
- إذا كانت نتائج البحث مرفقة، استخدمها للمعلومات الحديثة.
- لا تخترع مصادر أو روابط.
- عند استخدام نتائج البحث، اذكر المصادر بوضوح في الإجابة.
- ميّز بين المعلومات المؤكدة والاستنتاج.
- لا تعتبر نتيجة بحث واحدة حقيقة مطلقة إذا كانت المعلومات متعارضة.

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
          "Content-Type": "application/json",
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

    error.raw =
      raw;

    throw error;
  }

  let data;

  try {
    data =
      JSON.parse(raw);
  } catch {
    const error =
      new Error(
        "Gemini أعاد استجابة غير صالحة."
      );

    error.status =
      response.status;

    throw error;
  }

  const reply =
    data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

  if (!reply) {
    const error =
      new Error(
        "Gemini لم يُرجع نصًا."
      );

    error.status =
      response.status;

    throw error;
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
          text: item.content
        }
      ]
    });
  }

  contents.push({
    role: "user",

    parts: [
      {
        text: userMessage
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

      if (
        i ===
        GEMINI_MODELS.length - 1
      ) {
        break;
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

  const requestedUserId =
    String(
      body.user_id || ""
    ).trim();

  const userId =
    await getFirebaseUserId(
      request,
      env,
      requestedUserId
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

  let webResults = [];

  /*
    البحث يتم تلقائيًا فقط عندما يبدو
    أن السؤال يحتاج معلومات حديثة.
  */

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

      webResults = [];
    }
  }

  await saveMessage(
    env.DB,
    conversationId,
    userId,
    "user",
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
      String(
        body.user_id || ""
      ).trim()
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
      String(
        body.user_id || ""
      ).trim()
    );

  const memory =
    String(
      body.memory || body.content || ""
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
    body.category || "general",
    body.importance || 3,
    body.source || "user",
    body.confirmed || 0
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
      String(
        body.user_id || ""
      ).trim()
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
        "user_id و memory_id مطلوبان."
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
      String(
        body.user_id || ""
      ).trim()
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
      String(
        body.user_id || ""
      ).trim()
    );

  const conversationId =
    String(
      body.conversation_id || ""
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
      ? String(data.recurrence)
      : null;

  if (
    !text ||
    !dueAt
  ) {
    throw new Error(
      "نص التذكير وموعده مطلوبان."
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
    dueAt,
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

async function completeReminder(
  db,
  userId,
  reminderId
) {
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
      String(
        body.user_id || ""
      ).trim()
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
      body.reminder_action || ""
    ).trim();

  if (
    action ===
    "create"
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
    action ===
    "list"
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
    action ===
    "complete"
  ) {
    await completeReminder(
      env.DB,
      userId,
      String(body.reminder_id)
    );

    return json({
      ok: true
    });
  }

  if (
    action ===
    "delete"
  ) {
    await deleteReminder(
      env.DB,
      userId,
      String(body.reminder_id)
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

  const now =
    nowISO();

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
      now
    ).all();

  const reminders =
    result.results || [];

  /*
    لا نرسل Push Notification من Worker
    في هذه المرحلة.

    نسجل أن التذكير أصبح مستحقًا.
    الواجهة ستقرأ التذكيرات المستحقة
    عند فتح التطبيق/مراجعته.
  */

  for (const reminder of reminders) {
    console.log(
      "Reminder due:",
      reminder.id,
      reminder.user_id,
      reminder.text
    );

    /*
      التذكير المتكرر:
      لا نغيّر الموعد هنا حتى يتم تنفيذ
      منطق التكرار في النسخة النهائية
      للواجهة/الخلفية.

      التذكير العادي يصبح مكتملًا.
    */

    if (!reminder.recurrence) {
      await env.DB.prepare(`
        UPDATE reminders
        SET completed = 1
        WHERE id = ?
      `).bind(
        reminder.id
      ).run();
    }
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
            web_search: Boolean(
              env.EXA_API_KEY
            ),
            reminders: true,
            firebase:
              Boolean(
                env.FIREBASE_PROJECT_ID
              )
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
