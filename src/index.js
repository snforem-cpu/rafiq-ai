const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://snforem-cpu.github.io",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      ...CORS_HEADERS
    }
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    if (request.method === "GET") {
      return json({
        ok: true,
        test: "GET_OK"
      });
    }

    if (request.method === "POST") {
      return json({
        ok: true,
        test: "POST_OK",
        message: "Worker يستقبل POST بنجاح"
      });
    }

    return json({
      ok: false,
      error: "Method not allowed"
    }, 405);
  }
};
