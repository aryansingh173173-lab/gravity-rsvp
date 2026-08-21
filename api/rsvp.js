// Vercel serverless function — forwards RSVP submissions to the Google Apps
// Script web app. Configure APPS_SCRIPT_URL as an environment variable in
// the Vercel project settings (Settings > Environment Variables).

const SPREADSHEET_ID = '18tuY1IeFRz2XenryFE3kfXTiZxUbNa7Cs_4kExr9JU0';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ result: 'error', message: 'Method not allowed' });
    return;
  }

  const url = process.env.APPS_SCRIPT_URL;
  if (!url) {
    res.status(500).json({ result: 'error', message: 'APPS_SCRIPT_URL is not configured.' });
    return;
  }

  try {
    const payload = req.body;
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
      throw new Error('The Apps Script deployment points to the wrong spreadsheet. Redeploy the latest gravity-rsvp-appsscript.gs.');
    }

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ result: 'error', message: err.message });
  }
};
