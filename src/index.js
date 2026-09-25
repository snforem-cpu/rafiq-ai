const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://snforem-cpu.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

/*
  ترتيب النماذج من الأقوى إلى الأقل:
  1. Gemini 3.8 Flash
  2. Gemini 3.7 Flash
  3. Gemini 3.6 Flash
  4. Gemini 3.5 Flash
  5. Gemini 3.5 Flash-Lite

  يبدأ كل طلب دائمًا من النموذج الأول.
  إذا حدث خطأ مؤقت/ازدحام، ينتقل تلقائيًا للنموذج التالي.
*/

const GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite"
];

const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      ...CORS_HEADERS
    }
  });
}

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
    `)
  ]);
}

async function saveUser(db, userId) {
  await db.prepare(`
    INSERT OR IGNORE INTO users (id, created_at)
    VALUES (?, ?)
  `).bind(
    userId,
    new Date().toISOString()
  ).run();
}

async function saveConversation(
  db,
  conversationId,
  userId
) {
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT OR IGNORE INTO conversations
    (id, user_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    conversationId,
    userId,
    "محادثة جديدة",
    now,
    now
  ).run();

  await db.prepare(`
    UPDATE conversations
    SET updated_at = ?
    WHERE id = ?
  `).bind(
    now,
    conversationId
  ).run();
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
    new Date().toISOString()
  ).run();
}

async function getConversationHistory(
  db,
  conversationId,
  limit = 30
) {
  const result = await db.prepare(`
    SELECT role, content
    FROM messages
    WHERE conversation_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).bind(
    conversationId,
    limit
  ).all();

  return (result.results || []).reverse();
}

/*
  جدول memories الموجود أصلًا في D1 يحتوي على:
  id
  user_id
  category
  content
  importance
  source
  confirmed
  active
  created_at

  لذلك نستخدم content بدل memory.
*/

async function getUserMemories(
  db,
  userId
) {
  const result = await db.prepare(`
    SELECT id, category, content, importance, source,
           confirmed, active, created_at
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
  memory
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
    "general",
    clean,
    3,
    "conversation",
    0,
    1,
    new Date().toISOString()
  ).run();
}

async function deleteMemory(
  db,
  userId,
  memoryId
) {
  /*
    لا نحذف سجل الذاكرة نهائيًا.
    نجعله غير نشط للحفاظ على البيانات.
  */

  await db.prepare(`
    UPDATE memories
    SET active = 0
    WHERE id = ? AND user_id = ?
  `).bind(
    Number(memoryId),
    userId
  ).run();
}

function buildSystemInstruction(
  memories
) {
  let memoryText =
    "لا توجد معلومات محفوظة عن المستخدم حتى الآن.";

  if (memories.length > 0) {
    memoryText = memories
      .map(item => {
        const category =
          item.category
            ? ` [${item.category}]`
            : "";

        return `- ${item.content}${category}`;
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

المعلومات المحفوظة عن المستخدم:
${memoryText}
`;
}

/*
  نعتبر هذه الأخطاء مؤقتة أو مرتبطة بالضغط/التوافر.
  عند حدوثها ينتقل رفيق للنموذج التالي.

  لا ننتقل عند أخطاء مثل:
  400 = طلب غير صحيح
  401/403 = مشكلة صلاحية أو مفتاح
  404 = نموذج/مسار غير موجود
*/

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

  const response = await fetch(
    url,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key":
          env.GEMINI_API_KEY
      },

      body: JSON.stringify(payload)
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
  userMessage
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
              memories
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

  /*
    تجربة النماذج بالترتيب:
    3.8 → 3.7 → 3.6 → 3.5 → 3.5-lite
  */

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

      /*
        إذا كان الخطأ مؤقتًا،
        ننتقل للنموذج التالي.

        أما الخطأ غير القابل لإعادة المحاولة،
        نتوقف فورًا.
      */

      if (
        !isRetryableGeminiStatus(
          status
        )
      ) {
        throw error;
      }

      /*
        إذا كان هذا آخر نموذج،
        لا يوجد نموذج آخر للانتقال إليه.
      */

      if (
        i ===
        GEMINI_MODELS.length - 1
      ) {
        break;
      }
    }
  }

  /*
    جميع النماذج فشلت بسبب أخطاء مؤقتة.
  */

  if (lastError) {
    throw new Error(
      "جميع نماذج Gemini المتاحة مشغولة أو غير متاحة مؤقتًا. حاول مرة أخرى بعد قليل."
    );
  }

  throw new Error(
    "حدث خطأ أثناء الاتصال بالذكاء الاصطناعي."
  );
}

async function handleChat(
  request,
  env
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

  let body;

  try {
    body =
      await request.json();
  } catch {
    return json({
      ok: false,
      error: "Invalid JSON body."
    }, 400);
  }

  const userId =
    String(
      body.user_id || ""
    ).trim();

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
      error: "user_id مطلوب."
    }, 400);
  }

  if (!message) {
    return json({
      ok: false,
      error: "message مطلوب."
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
      30
    );

  const memories =
    await getUserMemories(
      env.DB,
      userId
    );

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
        message
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
      conversationId
  });
}

async function getMemories(
  request,
  env
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

  let body;

  try {
    body =
      await request.json();
  } catch {
    return json({
      ok: false,
      error: "Invalid JSON body."
    }, 400);
  }

  const userId =
    String(
      body.user_id || ""
    ).trim();

  if (!userId) {
    return json({
      ok: false,
      error: "user_id مطلوب."
    }, 400);
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

async function handleDeleteMemory(
  request,
  env
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

  let body;

  try {
    body =
      await request.json();
  } catch {
    return json({
      ok: false,
      error: "Invalid JSON body."
    }, 400);
  }

  const userId =
    String(
      body.user_id || ""
    ).trim();

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

async function handleSaveMemory(
  request,
  env
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

  let body;

  try {
    body =
      await request.json();
  } catch {
    return json({
      ok: false,
      error: "Invalid JSON body."
    }, 400);
  }

  const userId =
    String(
      body.user_id || ""
    ).trim();

  const memory =
    String(
      body.memory || ""
    ).trim();

  if (
    !userId ||
    !memory
  ) {
    return json({
      ok: false,
      error:
        "user_id و memory مطلوبان."
    }, 400);
  }

  await saveUser(
    env.DB,
    userId
  );

  await saveMemory(
    env.DB,
    userId,
    memory
  );

  return json({
    ok: true
  });
}

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

          /*
            النموذج الأساسي الذي يبدأ به كل طلب.
            قد ينتقل داخليًا إلى نموذج بديل
            إذا كان الأساسي مشغولًا.
          */
          model:
            GEMINI_MODELS[0],

          fallback_models:
            GEMINI_MODELS.slice(1)
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
          env
        );
      }

      if (
        action ===
        "get_memories"
      ) {
        return await getMemories(
          request,
          env
        );
      }

      if (
        action ===
        "delete_memory"
      ) {
        return await handleDeleteMemory(
          request,
          env
        );
      }

      if (
        action ===
        "save_memory"
      ) {
        return await handleSaveMemory(
          request,
          env
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
  }
};
