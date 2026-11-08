const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const config = {
  botToken: process.env.BOT_TOKEN || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  adminId: process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null,
  groupChatId: process.env.GROUP_CHAT_ID ? String(process.env.GROUP_CHAT_ID) : null,
  timezone: process.env.TIMEZONE || 'Europe/Kyiv',
  port: process.env.PORT ? Number(process.env.PORT) : null,
  googleSheetId: process.env.GOOGLE_SHEET_ID || '1qWVTXOfVQzn9VLEUWdZvIOvZt_omcd8j0Yr5QilzNt4',
  googleSheetGid: process.env.GOOGLE_SHEET_GID || '1261303835',
  googleScriptUrl: process.env.GOOGLE_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbwT1PR4M55Ck_KhT9L-CNe7-a7kf-OcAwefGS8xdhGEzlN_dQv8T-8yAzqafhIcedwk/exec',
  googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
};

function validateConfig() {
  const missing = [];
  if (!config.botToken || config.botToken === 'your_telegram_bot_token_here') {
    missing.push('BOT_TOKEN');
  }
  if (!config.geminiApiKey || config.geminiApiKey === 'your_gemini_api_key_here') {
    missing.push('GEMINI_API_KEY');
  }
  return missing;
}

module.exports = {
  config,
  validateConfig,
};
