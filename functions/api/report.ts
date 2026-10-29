// Cloudflare Pages Function: POST /api/report
interface Env {
  APPS: KVNamespace;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const { request, env } = context;
    const body = (await request.json()) as { id?: string; reason?: string };
    const id = body.id?.trim();

    if (!id || !env.APPS) {
      return new Response(JSON.stringify({ error: 'App ID required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const reportCountKey = `report_count:${id}`;
    const count = parseInt((await env.APPS.get(reportCountKey)) || '0', 10) + 1;
    await env.APPS.put(reportCountKey, String(count));

    // Auto-blocklist after 5 reports
    if (count >= 5) {
      await env.APPS.put(`blocklist:${id}`, 'true');
    }

    return new Response(JSON.stringify({ success: true, message: 'Report received.' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Report error';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
