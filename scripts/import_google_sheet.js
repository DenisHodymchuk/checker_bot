const { initDatabase } = require('../src/db/database');
const { runImport } = require('../src/services/google_sheet');

async function main() {
  await initDatabase();
  await runImport();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Помилка під час імпорту:', err);
    process.exit(1);
  });
}

module.exports = { runImport };
