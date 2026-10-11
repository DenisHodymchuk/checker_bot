const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const config = {
  botToken: process.env.BOT_TOKEN || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  adminId: process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null,
  groupChatId: process.env.GROUP_CHAT_ID ? String(process.env.GROUP_CHAT_ID) : null,
  timezone: process.env.TIMEZONE || 'Europe/Kyiv',
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
