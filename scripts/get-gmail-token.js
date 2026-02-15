/**
 * One-time script to get a Gmail OAuth2 refresh token.
 *
 * Usage:
 *   1. Run: node scripts/get-gmail-token.js
 *   2. Open the URL printed in your browser
 *   3. Sign in with alancarissawedding@gmail.com
 *   4. Grant access
 *   5. You'll be redirected to localhost:3099 -- the script captures the code
 *   6. The refresh token is printed to the console
 */

const http = require('http');
const { URL } = require('url');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Error: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set as environment variables.');
  console.error('Usage: GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=xxx node scripts/get-gmail-token.js');
  process.exit(1);
}
const REDIRECT_URI = 'http://localhost:3099/callback';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');

// Step 1: Build auth URL
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
  `client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&access_type=offline` +
  `&prompt=consent`;

console.log('\n=== Gmail OAuth2 Token Acquisition ===\n');
console.log('Open this URL in your browser:\n');
console.log(authUrl);
console.log('\nSign in with: alancarissawedding@gmail.com');
console.log('Waiting for callback...\n');

// Step 2: Start local server to catch the redirect
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:3099`);

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h2>Error: ${error}</h2><p>You can close this tab.</p>`);
      console.error('Auth error:', error);
      server.close();
      process.exit(1);
    }

    if (!code) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>No code received</h2>');
      return;
    }

    // Step 3: Exchange code for tokens
    try {
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: REDIRECT_URI,
          grant_type: 'authorization_code',
        }).toString(),
      });

      const tokenData = await tokenResponse.json();

      if (tokenData.error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h2>Token error: ${tokenData.error}</h2><p>${tokenData.error_description || ''}</p>`);
        console.error('Token error:', tokenData);
        server.close();
        process.exit(1);
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Success! Refresh token acquired.</h2><p>You can close this tab and return to the terminal.</p>');

      console.log('\n=== SUCCESS ===\n');
      console.log('GMAIL_REFRESH_TOKEN=' + tokenData.refresh_token);
      console.log('\nAccess token (temporary):', tokenData.access_token?.substring(0, 30) + '...');
      console.log('Expires in:', tokenData.expires_in, 'seconds');
      console.log('\nAdd this to your .env file on the server:');
      console.log(`GMAIL_CLIENT_ID=${CLIENT_ID}`);
      console.log(`GMAIL_CLIENT_SECRET=${CLIENT_SECRET}`);
      console.log(`GMAIL_REFRESH_TOKEN=${tokenData.refresh_token}`);

      server.close();
      process.exit(0);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h2>Error exchanging code</h2><p>${err.message}</p>`);
      console.error('Exchange error:', err);
      server.close();
      process.exit(1);
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(3099, () => {
  console.log('Callback server listening on http://localhost:3099');
});
