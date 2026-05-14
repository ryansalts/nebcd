// NEBCD — Cloudflare Worker OAuth Proxy for Decap CMS
// Deploy this worker, then set CLIENT_SECRET as a Secret in Worker settings
// Set CLIENT_ID below to your GitHub OAuth App's Client ID

const CLIENT_ID = 'YOUR_GITHUB_CLIENT_ID'; // replace before deploying

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Step 1 — redirect to GitHub OAuth
    if (path === '/auth') {
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        scope: 'repo,user',
        redirect_uri: `${url.origin}/callback`,
      });
      return Response.redirect(
        `https://github.com/login/oauth/authorize?${params}`, 302
      );
    }

    // Step 2 — handle GitHub callback, exchange code for token
    if (path === '/callback') {
      const code = url.searchParams.get('code');

      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          client_secret: env.CLIENT_SECRET,
          code,
        }),
      });

      const tokenData = await tokenRes.json();
      const token = tokenData.access_token;

      // Post token back to Decap CMS opener window
      const html = `<!DOCTYPE html>
<html>
<body>
<script>
(function() {
  function receiveMessage(e) {
    window.opener.postMessage(
      'authorization:github:success:{"token":"${token}","provider":"github"}',
      e.origin
    );
  }
  window.addEventListener("message", receiveMessage, false);
  window.opener.postMessage("authorizing:github", "*");
})();
<\/script>
</body>
</html>`;

      return new Response(html, {
        headers: { ...corsHeaders, 'Content-Type': 'text/html' },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
