const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://snforem-cpu.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";

const RAFIQ_SYSTEM_INSTRUCTION = `
أنت "رفيق AI"، مساعد شخصي بالذكاء الاصطناعي.

هويتك الثابتة:
- اسمك: رفيق AI.
- إذا سُئلت من أنت، قل: "أنا رفيق، مساعدك الشخصي بالذكاء الاصطناعي."
- إذا سُئلت من صنعك، قل: "شركة أكسون (Axon)."

الشخصية:
- ذكي، طبيعي، هادئ وعملي.
- أجب باللغة التي يستخدمها المستخدم.
- افهم سياق المحادثة.
- لا تدّع تنفيذ شيء لم تنفذه.
- استخدم ذاكرة المستخدم عندما تكون مفيدة.
- لا تحفظ كلمات المرور أو مفاتيح API أو الأسرار.
- احفظ فقط المعلومات المستقرة والمفيدة مستقبلًا.

أعد JSON وفق المخطط المحدد.
`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: {
      type: "STRING"
    },
    memories: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          category: {
            type: "STRING"
          },
          content: {
            type: "STRING"
          },
          importance: {
            type: "INTEGER"
          }
        },
        required: [
          "category",
          "content",
          "importance"
        ]
      }
    }
  },
  required: [
    "reply",
    "memories"
  ]
};

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        ...CORS_HEADERS
      }
    }
  );
}

function newId() {
  return crypto.randomUUID();
}

/* =========================
   D1
========================= */

async function ensureDatabase(env) {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        importance INTEGER DEFAULT 3,
        source TEXT DEFAULT 'conversation',
        confirmed INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS memory_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        memory_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `)
  ]);
}

async function ensureUser(env, userId) {
  await env.DB.prepare(`
    INSERT INTO users (id)
    VALUES (?)
    ON CONFLICT(id)
    DO UPDATE SET updated_at = CURRENT_TIMESTAMP
  `)
    .bind(userId)
    .run();
}

async function createConversation(env, userId) {
  const id = newId();

  await env.DB.prepare(`
    INSERT INTO conversations (
      id,
      user_id
    )
    VALUES (?, ?)
  `)
    .bind(id, userId)
    .run();

  return id;
}

async function loadMemories(env, userId) {
  const result = await env.DB.prepare(`
    SELECT
      id,
      category,
      content,
      importance
    FROM memories
    WHERE user_id = ?
      AND active = 1
    ORDER BY importance DESC, updated_at DESC
    LIMIT 100
  `)
    .bind(userId)
    .all();

  return result.results || [];
}

async function loadRecentMessages(
  env,
  userId,
  conversationId
) {
  const result = await env.DB.prepare(`
    SELECT
      role,
      content
    FROM messages
    WHERE user_id = ?
      AND conversation_id = ?
    ORDER BY id DESC
    LIMIT 20
  `)
    .bind(userId, conversationId)
    .all();

  return (result.results || []).reverse();
}

async function saveMessage(
  env,
  userId,
  conversationId,
  role,
  content
) {
  await env.DB.prepare(`
    INSERT INTO messages (
      conversation_id,
      user_id,
      role,
      content
    )
    VALUES (?, ?, ?, ?)
  `)
    .bind(
      conversationId,
      userId,
      role,
      content
    )
    .run();
}

async function saveMemory(
  env,
  userId,
  memory
) {
  if (!memory || !memory.content) {
    return;
  }

  const content =
    String(memory.content).trim().slice(0, 2000);

  if (!content) {
    return;
  }

  const category =
    String(
      memory.category || "general"
    ).slice(0, 100);

  let importance =
    Number(memory.importance);

  if (!Number.isFinite(importance)) {
    importance = 3;
  }

  importance = Math.max(
    1,
    Math.min(
      5,
      Math.round(importance)
    )
  );

  const existing =
    await env.DB.prepare(`
      SELECT id
      FROM memories
      WHERE user_id = ?
        AND content = ?
        AND active = 1
      LIMIT 1
    `)
      .bind(
        userId,
        content
      )
      .first();

  if (existing) {
    await env.DB.prepare(`
      UPDATE memories
      SET
        category = ?,
        importance = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
      .bind(
        category,
        importance,
        existing.id
      )
      .run();

    return;
  }

  await env.DB.prepare(`
    INSERT INTO memories (
      user_id,
      category,
      content,
      importance,
      source,
      active
    )
    VALUES (?, ?, ?, ?, 'conversation', 1)
  `)
    .bind(
      userId,
      category,
      content,
      importance
    )
    .run();
}

/* =========================
   Gemini
========================= */

async function callGemini(
  env,
  prompt
) {
  if (!env.GEMINI_API_KEY) {
    throw new Error(
      "مفتاح Gemini غير موجود في Worker."
    );
  }

  const response =
    await fetch(
      GEMINI_URL,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key":
            env.GEMINI_API_KEY
        },

        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text:
                  RAFIQ_SYSTEM_INSTRUCTION
              }
            ]
          },

          contents: [
            {
              role: "user",
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ],

          generationConfig: {
            responseMimeType:
              "application/json",

            responseSchema:
              RESPONSE_SCHEMA
          }
        })
      }
    );

  const raw =
    await response.text();

  let data = null;

  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      raw ||
      `Gemini HTTP ${response.status}`
    );
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

  if (!text) {
    throw new Error(
      "Gemini لم يُرجع نصًا."
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      reply: text,
      memories: []
    };
  }
}

/* =========================
   Chat
========================= */

async function handleChat(
  request,
  env
) {
  const body =
    await request.json();

  const userId =
    String(body.user_id || "").trim();

  const message =
    String(body.message || "").trim();

  if (!userId) {
    return json({
      ok: false,
      error: "user_id مطلوب."
    }, 400);
  }

  if (!message) {
    return json({
      ok: false,
      error: "الرسالة فارغة."
    }, 400);
  }

  await ensureUser(
    env,
    userId
  );

  let conversationId =
    String(
      body.conversation_id || ""
    ).trim();

  if (!conversationId) {
    conversationId =
      await createConversation(
        env,
        userId
      );
  }

  const memories =
    await loadMemories(
      env,
      userId
    );

  const recentMessages =
    await loadRecentMessages(
      env,
      userId,
      conversationId
    );

  const memoryText =
    memories.length
      ? memories
          .map(
            (m, i) =>
              `${i + 1}. [${m.category}] ${m.content}`
          )
          .join("\n")
      : "لا توجد ذاكرة محفوظة.";

  const historyText =
    recentMessages.length
      ? recentMessages
          .map(
            m =>
              `${m.role === "user" ? "المستخدم" : "رفيق"}: ${m.content}`
          )
          .join("\n")
      : "لا توجد رسائل سابقة في هذه المحادثة.";

  const prompt = `
الذاكرة المحفوظة عن المستخدم:
${memoryText}

سجل المحادثة الأخيرة:
${historyText}

رسالة المستخدم الجديدة:
${message}

أجب بشكل طبيعي ومفيد.

إذا ظهرت في الرسالة معلومة مستقرة ومفيدة مستقبلًا عن المستخدم،
يمكنك إضافتها إلى memories.

لا تحفظ:
- الأسئلة العادية.
- المعلومات المؤقتة.
- كلمات المرور.
- مفاتيح API.
- الرموز السرية.
- البيانات المالية الحساسة.

الرد يجب أن يكون باللغة المناسبة للمستخدم.
`;

  const result =
    await callGemini(
      env,
      prompt
    );

  const reply =
    String(
      result?.reply || ""
    ).trim();

  if (!reply) {
    throw new Error(
      "رفيق لم يُرجع ردًا صالحًا."
    );
  }

  await saveMessage(
    env,
    userId,
    conversationId,
    "user",
    message
  );

  await saveMessage(
    env,
    userId,
    conversationId,
    "assistant",
    reply
  );

  if (
    Array.isArray(result?.memories)
  ) {
    for (
      const memory of result.memories.slice(0, 10)
    ) {
      try {
        await saveMemory(
          env,
          userId,
          memory
        );
      } catch {
        // لا نفشل الرد بسبب الذاكرة.
      }
    }
  }

  await env.DB.prepare(`
    UPDATE conversations
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `)
    .bind(conversationId)
    .run();

  return json({
    ok: true,
    reply,
    conversation_id:
      conversationId
  });
}

/* =========================
   Memories
========================= */

async function getMemories(
  request,
  env
) {
  const body =
    await request.json();

  const userId =
    String(body.user_id || "").trim();

  if (!userId) {
    return json({
      ok: false,
      error: "user_id مطلوب."
    }, 400);
  }

  const result =
    await env.DB.prepare(`
      SELECT
        id,
        category,
        content,
        importance,
        created_at,
        updated_at
      FROM memories
      WHERE user_id = ?
        AND active = 1
      ORDER BY
        importance DESC,
        updated_at DESC
    `)
      .bind(userId)
      .all();

  return json({
    ok: true,
    memories:
      result.results || []
  });
}

async function deleteMemory(
  request,
  env
) {
  const body =
    await request.json();

  const userId =
    String(body.user_id || "").trim();

  const memoryId =
    Number(body.memory_id);

  if (
    !userId ||
    !Number.isInteger(memoryId)
  ) {
    return json({
      ok: false,
      error:
        "user_id و memory_id مطلوبان."
    }, 400);
  }

  await env.DB.prepare(`
    UPDATE memories
    SET
      active = 0,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND user_id = ?
  `)
    .bind(
      memoryId,
      userId
    )
    .run();

  return json({
    ok: true
  });
}

/* =========================
   Worker
========================= */

export default {
  async fetch(request, env) {

    if (
      request.method === "OPTIONS"
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

    if (
      request.method === "GET"
    ) {
      return json({
        ok: true,
        service: "Rafiq AI",
        status: "online"
      });
    }

    if (
      request.method !== "POST"
    ) {
      return json({
        ok: false,
        error: "Method not allowed."
      }, 405);
    }

    try {

      await ensureDatabase(
        env
      );

      const body =
        await request
          .clone()
          .json();

      const action =
        body?.action || "chat";

      if (
        action === "chat"
      ) {
        return await handleChat(
          request,
          env
        );
      }

      if (
        action === "get_memories"
      ) {
        return await getMemories(
          request,
          env
        );
      }

      if (
        action === "delete_memory"
      ) {
        return await deleteMemory(
          request,
          env
        );
      }

      return json({
        ok: false,
        error:
          "إجراء غير معروف."
      }, 400);

    } catch (error) {

      return json({
        ok: false,
        error:
          error?.message ||
          "حدث خطأ داخلي في رفيق AI."
      }, 500);
    }
  }
};
