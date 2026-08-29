const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const SPREADSHEET_ID = '18tuY1IeFRz2XenryFE3kfXTiZxUbNa7Cs_4kExr9JU0';

// Load environment variables from .env file
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  console.log(`[loadEnv] Reading .env from path: ${envPath}`);
  if (fs.existsSync(envPath)) {
    const fileContent = fs.readFileSync(envPath, 'utf8');
    console.log(`[loadEnv] Found file. Content length: ${fileContent.length}`);
    const lines = fileContent.split('\n');
    lines.forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = match[2] || '';
        val = val.trim();
        // Remove surrounding quotes if any
        if (val.length > 0 && val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') {
          val = val.substring(1, val.length - 1);
        }
        if (val.length > 0 && val.charAt(0) === "'" && val.charAt(val.length - 1) === "'") {
          val = val.substring(1, val.length - 1);
        }
        process.env[key] = val;
        console.log(`[loadEnv] Processed: ${key} = ${val}`);
      }
    });
  } else {
    console.log(`[loadEnv] File NOT found at: ${envPath}`);
  }
}

loadEnv();

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Helper function to forward RSVP details to Google Apps Script Web App
async function sendToAppsScript(payload) {
  const url = process.env.APPS_SCRIPT_URL;
  if (!url || url.includes('YOUR_APPS_SCRIPT_WEB_APP_URL_HERE')) {
    console.warn("WARNING: APPS_SCRIPT_URL is not configured in the .env file.");
    return { result: 'error', message: 'Apps Script URL not configured in .env' };
  }

  console.log(`Forwarding RSVP payload to Apps Script: ${url}`);
  
  // Use global fetch (supported natively in Node.js 18+)
  if (typeof fetch !== 'undefined') {
    try {
      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' }
      });
      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(`Apps Script returned HTTP ${response.status}: ${responseText.slice(0, 200)}`);
      }
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (_) {
        throw new Error('Apps Script did not return JSON. Check that the web app is deployed with access set to Anyone.');
      }
      if (data.result !== 'success') {
        throw new Error(data.message || 'Apps Script did not save the RSVP.');
      }
      if (data.spreadsheetId !== SPREADSHEET_ID) {
        throw new Error('The Apps Script deployment is outdated or points to the wrong spreadsheet. Redeploy the latest gravity-rsvp-appsscript.gs version.');
      }
      return data;
    } catch (err) {
      console.error("Fetch to Apps Script failed:", err);
      throw err;
    }
  } else {
    // Fallback using Node's standard https module (handles redirects)
    const https = require('https');
    return new Promise((resolve, reject) => {
      function makeRequest(targetUrl) {
        const parsedUrl = new URL(targetUrl);
        const options = {
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          }
        };

        const req = https.request(options, (res) => {
          // Handle redirect
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            makeRequest(res.headers.location);
            return;
          }

          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              resolve({ result: 'success', raw: data });
            }
          });
        });

        req.on('error', (err) => reject(err));
        req.write(JSON.stringify(payload));
        req.end();
      }
      
      makeRequest(url);
    });
  }
}

const server = http.createServer((req, res) => {
  // Extract path and decode URL components
  let safeUrl = decodeURIComponent(req.url);
  
  // Strip query parameters
  const queryIdx = safeUrl.indexOf('?');
  if (queryIdx !== -1) {
    safeUrl = safeUrl.substring(0, queryIdx);
  }

  // Handle API submissions
  if (req.method === 'POST' && safeUrl === '/api/rsvp') {
    console.log("\n--- Received RSVP Submission ---");
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        loadEnv(); // Reload environment variables dynamically
        console.log(`Configured APPS_SCRIPT_URL: ${process.env.APPS_SCRIPT_URL}`);
        const payload = JSON.parse(body);
        console.log("Payload received:", JSON.stringify(payload, null, 2));
        
        const result = await sendToAppsScript(payload);
        console.log("Apps Script response:", JSON.stringify(result, null, 2));
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error("Error processing/forwarding RSVP:", err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'error', message: err.message }));
      }
    });
    return;
  }

  let defaultPage = fs.existsSync(path.join(__dirname, 'gravity-rsvp-2026.html')) ? '/gravity-rsvp-2026.html' : '/index.html';
  let filePath = safeUrl === '/' ? defaultPage : safeUrl;
  filePath = path.join(__dirname, filePath);

  // Simple security check: ensure path is within the workspace directory
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  
  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>', 'utf-8');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  console.log(`Open http://localhost:${PORT}/ in your browser to view the site.`);
});
