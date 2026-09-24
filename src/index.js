const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://snforem-cpu.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1/interactions";

const GEMINI_MODEL = "gemini-3.8-flash";

/*
 * رفيق محادثة يومية.
 *
 * Gemini 3.8 Flash يستخدم medium افتراضيًا.
 * نستخدم low هنا لتقليل زمن الاستجابة للمحادثة العادية.
 * النموذج ما زال يستخدم التفكير، لكن بمستوى مناسب للدردشة.
 */
const GEMINI_THINKING_LEVEL = "low";

/*
 * لا نترك طلب Gemini معلقًا بلا نهاية.
 * هذا ليس حد Cloudflare؛ هو حد أمان خاص بطلبنا.
 */
const GEMINI_TIMEOUT_MS = 45000;

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

مهم جدًا:
- يجب أن يكون الإخراج JSON فقط.
- لا تضع Markdown خارج JSON.
- لا تضع أي شرح قبل JSON أو بعده.
- حقل reply هو الرد النهائي الذي سيظهر للمستخدم.
- حقل memories يحتوي فقط على معلومات جديدة ومستقرة ومفيدة مستقبلًا.
- لا تضف السؤال الحالي إلى memories.
- لا تضف معلومات مؤقتة أو عابرة إلى memories.
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
        "Content-Type":
          "application/json; charset=UTF-8",
        ...CORS_HEADERS
      }
    }
  );
}

function newId() {
  return crypto.randomUUID();
}

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

async function fetchWithTimeout(
  url,
  options,
  timeoutMs = GEMINI_TIMEOUT_MS
) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {
    return await fetch(
      url,
      {
        ...options,
        signal: controller.signal
      }
    );
  } finally {
    clearTimeout(timeout);
  }
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

async function createConversation(
  env,
  userId
) {
  const conversationId = newId();

  await env.DB.prepare(`
    INSERT INTO conversations (
      id,
      user_id,
      created_at,
      updated_at
    )
    VALUES (
      ?,
      ?,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
  `)
    .bind(
      conversationId,
      userId
    )
    .run();

  return conversationId;
}

async function loadMemoryContext(
  env,
  userId
) {
  if (!userId) return [];

  const result =
    await env.DB.prepare(`
      SELECT
        id,
        category,
        content,
        importance,
        confirmed
      FROM memories
      WHERE user_id = ?
        AND active = 1
      ORDER BY
        importance DESC,
        updated_at DESC
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
      return (
        `${index + 1}. ` +
        `[${memory.category}] ` +
        `${memory.content}`
      );
    })
    .join("\n");
}

async function saveMemory(
  env,
  userId,
  memory
) {
  if (
    !userId ||
    !memory ||
    !memory.content
  ) {
    return null;
  }

  const category =
    String(
      memory.category || "general"
    ).slice(0, 100);

  const content =
    String(
      memory.content
    ).slice(0, 2000);

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

  return (
    result.meta?.last_row_id ||
    null
  );
}

async function saveConversation(
  env,
  userId,
  conversationId,
  userMessage,
  assistantReply,
  interactionId
) {
  if (
    !conversationId ||
    !userId
  ) {
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
      VALUES (
        ?,
        ?,
        'user',
        ?
      )
    `).bind(
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
      VALUES (
        ?,
        ?,
        'assistant',
        ?
      )
    `).bind(
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
    `).bind(
      interactionId || null,
      conversationId
    )
  ]);
}

/*
 * استخراج النص من مخطط Interactions الجديد.
 *
 * Google تستخدم:
 * steps[]
 *   -> model_output
 *      -> content[]
 *         -> text
 */
function extractModelText(
  geminiData
) {
  if (
    typeof geminiData?.output_text ===
    "string" &&
    geminiData.output_text.trim()
  ) {
    return geminiData.output_text.trim();
  }

  const steps =
    Array.isArray(
      geminiData?.steps
    )
      ? geminiData.steps
      : [];

  for (
    let i = steps.length - 1;
    i >= 0;
    i--
  ) {
    const step = steps[i];

    if (
      step?.type !==
      "model_output"
    ) {
      continue;
    }

    const content =
      Array.isArray(
        step.content
      )
        ? step.content
        : [];

    for (
      let j = content.length - 1;
      j >= 0;
      j--
    ) {
      const item =
        content[j];

      if (
        item?.type === "text" &&
        typeof item.text === "string" &&
        item.text.trim()
      ) {
        return item.text.trim();
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

  /*
   * أحيانًا قد يعيد النموذج JSON داخل
   * code fence رغم تعليماته.
   * ننظفه قبل JSON.parse.
   */
  let cleanText =
    String(text).trim();

  if (
    cleanText.startsWith("```")
  ) {
    cleanText =
      cleanText
        .replace(
          /^```(?:json)?\s*/i,
          ""
        )
        .replace(
          /\s*```$/,
          ""
        )
        .trim();
  }

  try {
    const parsed =
      JSON.parse(cleanText);

    return {
      reply:
        typeof parsed.reply ===
        "string"
          ? parsed.reply
          : cleanText,

      memories:
        Array.isArray(
          parsed.memories
        )
          ? parsed.memories
          : []
    };
  } catch {
    /*
     * إذا وصل نص عادي بدل JSON،
     * لا نفشل المحادثة.
     */
    return {
      reply: cleanText,
      memories: []
    };
  }
}

async function parseGeminiError(
  response
) {
  const text =
    await response.text();

  let message =
    "حدث خطأ أثناء الاتصال بـGemini.";

  try {
    const data =
      JSON.parse(text);

    message =
      data?.error?.message ||
      data?.message ||
      message;
  } catch {
    if (text) {
      message =
        text.slice(0, 1500);
    }
  }

  return {
    message,
    raw: text
  };
}

async function createGeminiInteraction(
  env,
  requestBody
) {
  try {
    const response =
      await fetchWithTimeout(
        GEMINI_API_URL,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            "x-goog-api-key":
              env.GEMINI_API_KEY,

            /*
             * Google Interactions API
             * new schema revision.
             */
            "Api-Revision":
              "2026-05-20"
          },

          body:
            JSON.stringify(
              requestBody
            )
        }
      );

    return response;

  } catch (error) {
    if (
      error?.name ===
      "AbortError"
    ) {
      throw new Error(
        "انتهت مهلة الاتصال بـGemini قبل وصول الرد."
      );
    }

    throw error;
  }
}

async function handleChat(
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
      error:
        "user_id مطلوب."
    }, 400);
  }

  if (!message) {
    return json({
      ok: false,
      error:
        "الرسالة فارغة."
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

  /*
   * نستخدم conversation_id الموجود
   * من الواجهة، وإذا لم يوجد ننشئ واحدًا.
   */
  let conversationId =
    typeof body.conversation_id ===
      "string" &&
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

  /*
   * previous_interaction_id اختياري.
   *
   * إذا كان موجودًا نرسله إلى Gemini
   * حتى يحافظ على سياق المحادثة.
   */
  const previousInteractionId =
    typeof body.previous_interaction_id ===
      "string" &&
    body.previous_interaction_id.trim()
      ? body.previous_interaction_id.trim()
      : null;

  const memories =
    await loadMemoryContext(
      env,
      userId
    );

  const memoryContext =
    buildMemoryContext(
      memories
    );

  const input = `
معلومات الذاكرة الحالية للمستخدم:
${memoryContext}

رسالة المستخدم الحالية:
${message}

أجب باللغة المناسبة للغة المستخدم.

إذا كانت هناك معلومة جديدة مستقرة ومفيدة مستقبلًا، أضفها إلى memories.

لا تضف إلى memories:
- محتوى السؤال نفسه.
- معلومات مؤقتة.
- معلومات لم يقلها المستخدم.
- تخمينات عن المستخدم.

إذا لم توجد ذاكرة جديدة، أعد memories كمصفوفة فارغة.
`;

  /*
   * الطلب النهائي إلى Gemini.
   *
   * thinking_level = low
   * لتجنب زمن التفكير الطويل في المحادثة العادية.
   */
  const requestBody = {
    model:
      GEMINI_MODEL,

    input,

    system_instruction:
      RAFIQ_SYSTEM_INSTRUCTION,

    generation_config: {
      thinking_level:
        GEMINI_THINKING_LEVEL
    },

    response_format: {
      type: "text",
      mime_type:
        "application/json",
      schema:
        MEMORY_RESPONSE_SCHEMA
    },

    /*
     * نحتاج تخزين Interaction
     * لأننا نستخدم previous_interaction_id.
     */
    store: true
  };

  if (previousInteractionId) {
    requestBody.previous_interaction_id =
      previousInteractionId;
  }

  let geminiResponse;

  try {
    geminiResponse =
      await createGeminiInteraction(
        env,
        requestBody
      );
  } catch (error) {
    return json({
      ok: false,
      error:
        error?.message ||
        "تعذر الاتصال بخدمة Gemini."
    }, 504);
  }

  /*
   * إذا رفض Gemini الطلب،
   * نعيد الخطأ الحقيقي بدل إبقاء الواجهة
   * في حالة "جاري التفكير".
   */
  if (!geminiResponse.ok) {
    const error =
      await parseGeminiError(
        geminiResponse
      );

    /*
     * إذا كانت المشكلة في Interaction قديمة
     * محفوظة في المتصفح، نوضح ذلك.
     */
    return json({
      ok: false,
      error:
        error.message,
      gemini_status:
        geminiResponse.status
    }, geminiResponse.status);
  }

  let geminiData;

  try {
    geminiData =
      await geminiResponse.json();
  } catch {
    return json({
      ok: false,
      error:
        "وصل رد من Gemini لكنه ليس JSON صالحًا."
    }, 502);
  }

  /*
   * Interactions API يعيد status.
   *
   * في الطلب المتزامن الطبيعي نحتاج completed.
   */
  const interactionStatus =
    geminiData?.status ||
    null;

  if (
    interactionStatus &&
    interactionStatus !==
      "completed"
  ) {
    if (
      interactionStatus ===
      "in_progress"
    ) {
      return json({
        ok: false,
        error:
          "Gemini ما زال يعالج الطلب. أعد إرسال الرسالة بعد لحظة.",
        interaction_id:
          geminiData.id || null,
        status:
          interactionStatus
      }, 504);
    }

    return json({
      ok: false,
      error:
        `انتهت عملية Gemini بحالة: ${interactionStatus}.`,
      interaction_id:
        geminiData.id || null,
      status:
        interactionStatus
    }, 502);
  }

  const modelText =
    extractModelText(
      geminiData
    );

  if (!modelText) {
    return json({
      ok: false,
      error:
        "وصلت استجابة من Gemini، لكن لم يتم العثور على نص الرد.",
      interaction_id:
        geminiData.id || null,
      status:
        interactionStatus
    }, 502);
  }

  const parsed =
    parseAssistantPayload(
      modelText
    );

  const assistantReply =
    parsed.reply;

  const savedMemories = [];

  /*
   * حفظ الذاكرة لا يجب أن يمنع
   * ظهور رد رفيق للمستخدم.
   */
  if (
    Array.isArray(
      parsed.memories
    )
  ) {
    for (
      const memory of
      parsed.memories.slice(
        0,
        10
      )
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
         * نتجاهل خطأ الذاكرة
         * ولا نفشل المحادثة.
         */
      }
    }
  }

  /*
   * حفظ المحادثة في D1.
   */
  try {
    await saveConversation(
      env,
      userId,
      conversationId,
      message,
      assistantReply,
      geminiData.id || null
    );
  } catch (error) {
    /*
     * الرد نفسه أهم من فشل الحفظ.
     */
    console.error(
      "D1 saveConversation error:",
      error
    );
  }

  return json({
    ok: true,

    reply:
      assistantReply,

    interaction_id:
      geminiData.id || null,

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
    Number(
      body.memory_id
    );

  if (
    !userId ||
    !Number.isInteger(
      memoryId
    )
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
        updated_at =
          CURRENT_TIMESTAMP
      WHERE id = ?
        AND user_id = ?
    `).bind(
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
    `).bind(
      userId,
      memoryId
    )
  ]);

  return json({
    ok: true
  });
}

export default {
  async fetch(
    request,
    env
  ) {
    /*
     * CORS preflight
     */
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

    /*
     * Health check
     */
    if (
      request.method ===
      "GET"
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
      request.method !==
      "POST"
    ) {
      return json({
        ok: false,
        error:
          "Method not allowed."
      }, 405);
    }

    try {
      /*
       * نقرأ نسخة من body لتحديد action
       * بدون استهلاك body الأصلي.
       */
      const body =
        await request
          .clone()
          .json();

      const action =
        body?.action ||
        "chat";

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
      console.error(
        "Rafiq Worker error:",
        error
      );

      return json({
        ok: false,
        error:
          error?.message ||
          "حدث خطأ داخلي في رفيق."
      }, 500);
    }
  }
};
