const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://snforem-cpu.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

const GEMINI_BASE =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

const RAFIQ_SYSTEM_INSTRUCTION = `
أنت "رفيق AI"، مساعد شخصي بالذكاء الاصطناعي.

هويتك الثابتة:
- اسمك: رفيق AI
- وصفك: "أنا رفيق، مساعدك الشخصي بالذكاء الاصطناعي."
- إذا سُئلت: من صنعك؟ أجب: "شركة أكسون (Axon)."

شخصيتك:
- ذكي، هادئ، طبيعي وعملي.
- افهم سياق المحادثة ولا تكرر أسئلة تمت الإجابة عنها.
- كن صريحًا عندما لا تعرف شيئًا.
- لا تدّعِ أنك نفذت إجراءً أو استخدمت أداة إذا لم يحدث ذلك فعليًا.
- استخدم المعلومات الموجودة في ذاكرة المستخدم عندما تكون مفيدة للسؤال الحالي.
- لا تعتبر أي معلومة في الذاكرة حقيقة مطلقة إذا تعارضت مع ما يقوله المستخدم الآن.
- لا تحفظ كلمات المرور أو مفاتيح API أو الرموز السرية أو البيانات المالية الحساسة.
- إذا طلب المستخدم حفظ معلومة شخصية مفيدة للمحادثات المستقبلية، اقترح حفظها ضمن الذاكرة.
- لا تحفظ كل شيء تلقائيًا؛ احفظ المعلومات المستقرة والمفيدة مستقبلًا فقط.

مهم:
أعد JSON فقط وفق المخطط المطلوب.
حقل reply يحتوي الرد الذي سيظهر للمستخدم.
حقل memories يحتوي فقط على معلومات جديدة ومستقرة ومفيدة مستقبلًا.
`;

const MEMORY_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reply: {
      type: "string"
    },
    memories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: {
            type: "string"
          },
          content: {
            type: "string"
          },
          importance: {
            type: "integer",
            minimum: 1,
            maximum: 5
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

/*
 * تهيئة قاعدة بيانات D1 تلقائيًا.
 *
 * هذه الخطوة تمنع فشل Worker إذا كانت الجداول
 * لم تُنشأ مسبقًا في قاعدة البيانات.
 */
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
        gemini_interaction_id TEXT,
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
  if (!userId) return;

  await env.DB.prepare(`
    INSERT INTO users (id)
    VALUES (?)
    ON CONFLICT(id) DO UPDATE SET
      updated_at = CURRENT_TIMESTAMP
  `)
    .bind(userId)
    .run();
}

async function createConversation(env, userId) {
  const conversationId = newId();

  await env.DB.prepare(`
    INSERT INTO conversations (
      id,
      user_id,
      created_at,
      updated_at
    )
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `)
    .bind(
      conversationId,
      userId
    )
    .run();

  return conversationId;
}

async function loadMemoryContext(env, userId) {
  if (!userId) return [];

  const result = await env.DB.prepare(`
    SELECT
      id,
      category,
      content,
      importance,
      confirmed
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

function buildMemoryContext(memories) {
  if (!memories.length) {
    return "لا توجد معلومات محفوظة عن المستخدم حتى الآن.";
  }

  return memories
    .map((memory, index) => {
      return `${index + 1}. [${memory.category}] ${memory.content}`;
    })
    .join("\n");
}

async function saveMemory(env, userId, memory) {
  if (!userId || !memory?.content) {
    return null;
  }

  const category =
    String(memory.category || "general")
      .slice(0, 100);

  const content =
    String(memory.content)
      .slice(0, 2000);

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
        AND active = 1
        AND content = ?
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

    return existing.id;
  }

  const result =
    await env.DB.prepare(`
      INSERT INTO memories (
        user_id,
        category,
        content,
        importance,
        source,
        confirmed,
        active
      )
      VALUES (
        ?,
        ?,
        ?,
        ?,
        'conversation',
        0,
        1
      )
    `)
      .bind(
        userId,
        category,
        content,
        importance
      )
      .run();

  return result.meta?.last_row_id || null;
}

async function saveConversation(
  env,
  userId,
  conversationId,
  userMessage,
  assistantReply,
  interactionId
) {
  if (!conversationId || !userId) {
    return;
  }

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO messages (
        conversation_id,
        user_id,
        role,
        content
      )
      VALUES (?, ?, 'user', ?)
    `)
      .bind(
        conversationId,
        userId,
        userMessage
      ),

    env.DB.prepare(`
      INSERT INTO messages (
        conversation_id,
        user_id,
        role,
        content
      )
      VALUES (?, ?, 'assistant', ?)
    `)
      .bind(
        conversationId,
        userId,
        assistantReply
      ),

    env.DB.prepare(`
      UPDATE conversations
      SET
        gemini_interaction_id = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
      .bind(
        interactionId || null,
        conversationId
      )
  ]);
}

function extractModelText(geminiData) {
  if (
    typeof geminiData?.output_text === "string" &&
    geminiData.output_text.trim()
  ) {
    return geminiData.output_text;
  }

  const steps =
    Array.isArray(geminiData?.steps)
      ? geminiData.steps
      : [];

  for (
    let i = steps.length - 1;
    i >= 0;
    i--
  ) {
    const step = steps[i];

    if (step?.type !== "model_output") {
      continue;
    }

    const content =
      Array.isArray(step.content)
        ? step.content
        : [];

    for (
      let j = content.length - 1;
      j >= 0;
      j--
    ) {
      const item = content[j];

      if (
        item?.type === "text" &&
        typeof item.text === "string" &&
        item.text.trim()
      ) {
        return item.text;
      }
    }
  }

  return "";
}

function parseAssistantPayload(text) {
  if (!text) {
    return {
      reply:
        "لم يصلني رد من نموذج الذكاء الاصطناعي.",
      memories: []
    };
  }

  try {
    const parsed =
      JSON.parse(text);

    return {
      reply:
        typeof parsed.reply === "string"
          ? parsed.reply
          : text,

      memories:
        Array.isArray(parsed.memories)
          ? parsed.memories
          : []
    };
  } catch {
    return {
      reply: text,
      memories: []
    };
  }
}

async function geminiRequest(
  env,
  path = "",
  options = {}
) {
  const response =
    await fetch(
      `${GEMINI_BASE}${path}`,
      {
        ...options,

        headers: {
          "Content-Type": "application/json",

          "x-goog-api-key":
            env.GEMINI_API_KEY,

          "Api-Revision":
            "2026-05-20",

          ...(options.headers || {})
        }
      }
    );

  const text =
    await response.text();

  let data = null;

  try {
    data = text
      ? JSON.parse(text)
      : null;
  } catch {
    data = null;
  }

  return {
    response,
    text,
    data
  };
}

async function createBackgroundInteraction(
  env,
  input,
  previousInteractionId
) {
  const requestBody = {
    model: "gemini-3.8-flash",

    input,

    background: true,

    store: true,

    system_instruction:
      RAFIQ_SYSTEM_INSTRUCTION,

    response_format: {
      type: "text",
      mime_type: "application/json",
      schema:
        MEMORY_RESPONSE_SCHEMA
    }
  };

  if (previousInteractionId) {
    requestBody.previous_interaction_id =
      previousInteractionId;
  }

  return await geminiRequest(
    env,
    "",
    {
      method: "POST",
      body:
        JSON.stringify(requestBody)
    }
  );
}

async function getInteraction(
  env,
  interactionId
) {
  return await geminiRequest(
    env,
    `/${encodeURIComponent(interactionId)}`,
    {
      method: "GET"
    }
  );
}

async function handleChatStart(
  request,
  env
) {
  const body =
    await request.json();

  const userId =
    String(
      body.user_id || ""
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
      error: "الرسالة فارغة."
    }, 400);
  }

  if (!env.GEMINI_API_KEY) {
    return json({
      ok: false,
      error:
        "مفتاح Gemini غير مضبوط في Worker."
    }, 500);
  }

  await ensureUser(
    env,
    userId
  );

  let conversationId =
    typeof body.conversation_id === "string" &&
    body.conversation_id.trim()
      ? body.conversation_id.trim()
      : null;

  if (!conversationId) {
    conversationId =
      await createConversation(
        env,
        userId
      );
  }

  const previousInteractionId =
    typeof body.previous_interaction_id === "string" &&
    body.previous_interaction_id.trim()
      ? body.previous_interaction_id.trim()
      : null;

  const memories =
    await loadMemoryContext(
      env,
      userId
    );

  const memoryContext =
    buildMemoryContext(memories);

  const input = `
معلومات الذاكرة الحالية للمستخدم:
${memoryContext}

رسالة المستخدم الحالية:
${message}

أجب باللغة المناسبة للغة المستخدم.

إذا كانت هناك معلومة جديدة مستقرة ومفيدة مستقبلًا،
أضفها إلى memories.

لا تضف إلى memories مجرد محتوى السؤال
أو معلومات مؤقتة.
`;

  const result =
    await createBackgroundInteraction(
      env,
      input,
      previousInteractionId
    );

  if (!result.response.ok) {
    let errorMessage =
      "حدث خطأ أثناء إنشاء مهمة Gemini.";

    if (result.data?.error?.message) {
      errorMessage =
        result.data.error.message;
    } else if (result.text) {
      errorMessage =
        result.text.slice(0, 1000);
    }

    return json({
      ok: false,
      error: errorMessage
    }, result.response.status);
  }

  const interaction =
    result.data;

  if (!interaction?.id) {
    return json({
      ok: false,
      error:
        "لم يُعد Gemini بمعرّف Interaction."
    }, 502);
  }

  return json({
    ok: true,
    pending: true,

    interaction_id:
      interaction.id,

    conversation_id:
      conversationId,

    status:
      interaction.status ||
      "in_progress"
  });
}

async function handleInteractionStatus(
  request,
  env
) {
  const body =
    await request.json();

  const userId =
    String(
      body.user_id || ""
    ).trim();

  const interactionId =
    String(
      body.interaction_id || ""
    ).trim();

  const conversationId =
    String(
      body.conversation_id || ""
    ).trim();

  const userMessage =
    String(
      body.message || ""
    ).trim();

  if (!userId) {
    return json({
      ok: false,
      error: "user_id مطلوب."
    }, 400);
  }

  if (!interactionId) {
    return json({
      ok: false,
      error:
        "interaction_id مطلوب."
    }, 400);
  }

  const result =
    await getInteraction(
      env,
      interactionId
    );

  if (!result.response.ok) {
    let errorMessage =
      "تعذر الحصول على حالة Gemini.";

    if (result.data?.error?.message) {
      errorMessage =
        result.data.error.message;
    } else if (result.text) {
      errorMessage =
        result.text.slice(0, 1000);
    }

    return json({
      ok: false,
      error: errorMessage
    }, result.response.status);
  }

  const interaction =
    result.data || {};

  const status =
    interaction.status ||
    "unknown";

  /*
   * حالات الانتظار:
   * queued = الطلب في الطابور
   * in_progress = Gemini يعمل عليه
   */
  if (
    status === "queued" ||
    status === "in_progress"
  ) {
    return json({
      ok: true,
      pending: true,
      status,
      interaction_id:
        interactionId
    });
  }

  /*
   * حالة requires_action
   * لا نعتبرها نجاحًا أو فشلًا صامتًا.
   */
  if (status === "requires_action") {
    return json({
      ok: false,
      pending: false,
      status,
      interaction_id:
        interactionId,
      error:
        "Gemini يحتاج إلى إجراء إضافي قبل إكمال المهمة."
    }, 502);
  }

  if (
    status !== "completed" &&
    status !== "incomplete"
  ) {
    return json({
      ok: false,
      pending: false,
      status,
      interaction_id:
        interactionId,
      error:
        interaction?.error?.message ||
        `انتهت مهمة Gemini بحالة: ${status}.`
    }, 502);
  }

  const modelText =
    extractModelText(
      interaction
    );

  if (!modelText) {
    return json({
      ok: false,
      pending: false,
      status,
      interaction_id:
        interactionId,
      error:
        "اكتملت مهمة Gemini لكن لم يتم العثور على نص الرد."
    }, 502);
  }

  const parsed =
    parseAssistantPayload(
      modelText
    );

  const assistantReply =
    parsed.reply;

  const savedMemories = [];

  if (
    Array.isArray(parsed.memories)
  ) {
    for (
      const memory of
      parsed.memories.slice(0, 10)
    ) {
      try {
        const id =
          await saveMemory(
            env,
            userId,
            memory
          );

        if (id) {
          savedMemories.push({
            id,
            category:
              memory.category,
            content:
              memory.content
          });
        }
      } catch {
        /*
         * لا نفشل الرد بسبب فشل حفظ الذاكرة.
         */
      }
    }
  }

  if (conversationId) {
    await saveConversation(
      env,
      userId,
      conversationId,
      userMessage,
      assistantReply,
      interactionId
    );
  }

  return json({
    ok: true,
    pending: false,
    status,

    reply:
      assistantReply,

    interaction_id:
      interactionId,

    conversation_id:
      conversationId,

    saved_memories:
      savedMemories
  });
}

async function getMemories(
  request,
  env
) {
  const body =
    await request.json();

  const userId =
    String(
      body.user_id || ""
    ).trim();

  if (!userId) {
    return json({
      ok: false,
      error:
        "user_id مطلوب."
    }, 400);
  }

  await ensureUser(
    env,
    userId
  );

  const result =
    await env.DB.prepare(`
      SELECT
        id,
        category,
        content,
        importance,
        confirmed,
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
    String(
      body.user_id || ""
    ).trim();

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

  const memory =
    await env.DB.prepare(`
      SELECT id
      FROM memories
      WHERE id = ?
        AND user_id = ?
        AND active = 1
      LIMIT 1
    `)
      .bind(
        memoryId,
        userId
      )
      .first();

  if (!memory) {
    return json({
      ok: false,
      error:
        "الذاكرة غير موجودة."
    }, 404);
  }

  await env.DB.batch([
    env.DB.prepare(`
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
      ),

    env.DB.prepare(`
      INSERT INTO memory_actions (
        user_id,
        memory_id,
        action,
        details
      )
      VALUES (
        ?,
        ?,
        'delete',
        'Deleted by user'
      )
    `)
      .bind(
        userId,
        memoryId
      )
  ]);

  return json({
    ok: true
  });
}

export default {
  async fetch(request, env) {
    /*
     * CORS preflight
     */
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

    /*
     * Health check
     */
    if (
      request.method === "GET"
    ) {
      return json({
        ok: true,
        service:
          "Rafiq AI",
        status:
          "online"
      });
    }

    if (
      request.method !== "POST"
    ) {
      return json({
        ok: false,
        error:
          "Method not allowed."
      }, 405);
    }

    try {
      /*
       * تهيئة D1 قبل أي عملية تستخدم الجداول.
       */
      await ensureDatabase(env);

      const body =
        await request
          .clone()
          .json();

      const action =
        body?.action ||
        "chat";

      if (
        action === "chat"
      ) {
        return await handleChatStart(
          request,
          env
        );
      }

      if (
        action === "interaction_status"
      ) {
        return await handleInteractionStatus(
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
      /*
       * مهم:
       * نعيد الخطأ عبر نفس CORS headers
       * حتى لا يظهر للواجهة كـ Failed to fetch.
       */
      return json({
        ok: false,
        error:
          error?.message ||
          "حدث خطأ داخلي في Rafiq AI."
      }, 500);
    }
  }
};
