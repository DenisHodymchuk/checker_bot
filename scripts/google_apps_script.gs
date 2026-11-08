/**
 * ============================================================================
 * GOOGLE APPS SCRIPT ДЛЯ АВТОМАТИЧНОГО ЗАПИСУ КРОКІВ ТА ШТРАФІВ З TELEGRAM БОТА
 * ============================================================================
 * Як підключити (займає 1 хвилину):
 * 1. Відкрийте вашу Google Таблицю:
 *    https://docs.google.com/spreadsheets/d/1qWVTXOfVQzn9VLEUWdZvIOvZt_omcd8j0Yr5QilzNt4/edit
 * 2. У верхньому меню натисніть: Розширення (Extensions) -> Apps Script
 * 3. Видаліть весь код, який там є, і вставте цей файл повністю. Натисніть 💾 (Зберегти).
 * 4. Справа вгорі натисніть синю кнопку "Розгорнути" (Deploy) -> "Нове розгортання" (New deployment).
 * 5. Натисніть на шестерню ⚙️ біля "Виберіть тип" -> оберіть "Веб-додаток" (Web app).
 * 6. У полі "Хто має доступ" (Who has access) ОБОВ'ЯЗКОВО оберіть: "Усі" (Anyone).
 * 7. Натисніть "Розгорнути" (Deploy), надайте дозвіл і скопіюйте отриманий URL веб-додатку.
 * 8. Надішліть цей URL боту командою:
 *    /set_sheet_url https://script.google.com/macros/s/ВАШ_КОД/exec
 * ============================================================================
 */

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = null;

    if (payload.gid) {
      var sheets = ss.getSheets();
      for (var i = 0; i < sheets.length; i++) {
        if (String(sheets[i].getSheetId()) === String(payload.gid)) {
          sheet = sheets[i];
          break;
        }
      }
    }
    if (!sheet) {
      sheet = ss.getActiveSheet();
    }

    var data = sheet.getDataRange().getValues();
    if (data.length < 2) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Sheet is empty' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 1. Знаходимо рядок заголовків із числами місяця (1..31) — зазвичай рядок 2 (індекс 1)
    var headerRowIdx = 1;
    for (var r = 0; r < Math.min(5, data.length); r++) {
      if (String(data[r][1]).toLowerCase().indexOf('штраф') !== -1 || String(data[r][4]) === '1') {
        headerRowIdx = r;
        break;
      }
    }

    var dayToCol = {}; // { "1": 5, "2": 6, ... } (1-based column index)
    var sumCols = [];  // колонки "ВСЬОГО кроків за ..."
    var headerRow = data[headerRowIdx];
    for (var c = 4; c < headerRow.length; c++) {
      var cellVal = String(headerRow[c]).trim();
      if (/^\d{1,2}$/.test(cellVal)) {
        dayToCol[cellVal] = c + 1;
      } else if (cellVal.toLowerCase().indexOf('всього') !== -1) {
        sumCols.push(c + 1);
      }
    }

    var updates = payload.updates || [];
    var updatedCount = 0;

    for (var uIdx = 0; uIdx < updates.length; uIdx++) {
      var u = updates[uIdx];
      var cleanHandle = u.username ? ('@' + String(u.username).replace(/^@/, '').trim()).toLowerCase() : '';
      var cleanName = u.name ? String(u.name).trim().toLowerCase() : '';

      var targetRow = -1; // 1-based row index in sheet
      for (var rIdx = headerRowIdx + 1; rIdx < data.length; rIdx++) {
        var rowHandle = String(data[rIdx][2] || '').trim().toLowerCase();
        var rowName = String(data[rIdx][3] || '').trim().toLowerCase();
        if (String(data[rIdx][1] || '').toLowerCase().indexOf('штраф') !== -1) {
          break; // дійшли до нижнього рядка підсумків
        }
        if (cleanHandle && rowHandle === cleanHandle) {
          targetRow = rIdx + 1;
          break;
        }
        if (cleanName && rowName && (rowName === cleanName || rowName.indexOf(cleanName) === 0 || cleanName.indexOf(rowName) === 0)) {
          targetRow = rIdx + 1;
          break;
        }
      }

      if (targetRow === -1) continue;

      // Якщо у таблиці не був вказаний @username, а тепер він відомий — дописуємо в колонку C
      if (u.username && !String(data[targetRow - 1][2] || '').trim()) {
        var formattedHandle = '@' + String(u.username).replace(/^@/, '').trim();
        sheet.getRange(targetRow, 3).setValue(formattedHandle);
      }

      // Оновлюємо колонку B ("штрафні дні", наприклад "0/2", "1/2", "3/2")
      if (u.penaltiesText) {
        var penCell = sheet.getRange(targetRow, 2);
        penCell.setNumberFormat('@');
        penCell.setValue(String(u.penaltiesText));
      }

      // Оновлюємо кроки за дні
      if (u.days) {
        for (var dayKey in u.days) {
          var colNum = dayToCol[String(Number(dayKey))];
          if (colNum && u.days[dayKey] !== null && u.days[dayKey] !== undefined) {
            var stepCell = sheet.getRange(targetRow, colNum);
            stepCell.setNumberFormat('#,##0');
            stepCell.setValue(Number(u.days[dayKey]));
          }
        }
      }

      // Відновлюємо формули суми (колонки J, P, V, AB, AH, AN), якщо вони порожні
      var formulaDefs = [
        { col: 10, formula: '=SUM(E' + targetRow + ':I' + targetRow + ')' },
        { col: 16, formula: '=J' + targetRow + '+SUM(K' + targetRow + ':O' + targetRow + ')' },
        { col: 22, formula: '=P' + targetRow + '+SUM(Q' + targetRow + ':U' + targetRow + ')' },
        { col: 28, formula: '=V' + targetRow + '+SUM(W' + targetRow + ':AA' + targetRow + ')' },
        { col: 34, formula: '=AB' + targetRow + '+SUM(AC' + targetRow + ':AG' + targetRow + ')' },
        { col: 40, formula: '=AH' + targetRow + '+SUM(AI' + targetRow + ':AM' + targetRow + ')' }
      ];
      for (var f = 0; f < formulaDefs.length; f++) {
        var fDef = formulaDefs[f];
        var fCell = sheet.getRange(targetRow, fDef.col);
        if (!fCell.getFormula()) {
          fCell.setFormula(fDef.formula);
          fCell.setNumberFormat('#,##0');
        }
      }

      updatedCount++;
    }

    return ContentService.createTextOutput(JSON.stringify({ ok: true, updated: updatedCount }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
