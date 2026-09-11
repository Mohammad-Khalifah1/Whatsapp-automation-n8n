/**
 * WhatsApp Support — sheet tooling.
 *
 * Paste into Extensions -> Apps Script alongside SetupSheet.gs, save, then run
 * `installTriggers` once and approve the permission prompt.
 *
 * WHAT THIS ADDS
 *   - A status dropdown, coloured so the queue is readable without reading.
 *   - An agent dropdown fed from the Agents tab, so names cannot be mistyped.
 *     A mistyped name is not cosmetic: routing and reporting both key on it.
 *   - Choosing ARCHIVED moves the row to the Archive tab IMMEDIATELY, on edit.
 *   - A menu for replying, opening the chat, and repairing agent counters.
 */

var CONV_TAB = 'Conversations';
var ARCHIVE_TAB = 'Archive';
var AGENTS_TAB = 'Agents';

var STATUSES = [
  'WAITING_FOR_AGENT',
  'UNANSWERED',
  'REPLIED',
  'WAITING_FOR_CUSTOMER',
  'CLOSED',
  'ARCHIVED'
];

/** Chosen so the state is obvious at a glance, before any text is read. */
var STATUS_COLORS = {
  WAITING_FOR_AGENT:    '#f8d7d5',  // red    - nobody owns this
  UNANSWERED:           '#fdf0cd',  // amber  - customer is waiting
  REPLIED:              '#d9ead3',  // green  - ball in customer's court
  WAITING_FOR_CUSTOMER: '#d9ead3',
  CLOSED:               '#eceff2',  // grey   - finished
  ARCHIVED:             '#e0d8ef'   // violet - moved out of the working sheet
};

/* ───────────────────────────── menu & triggers ───────────────────────────── */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('WhatsApp Support')
    .addItem('Reply to selected conversation…', 'replyToSelected')
    .addItem('Open WhatsApp chat', 'openWhatsAppChat')
    .addSeparator()
    .addItem('Archive selected rows', 'archiveSelected')
    .addSeparator()
    .addItem('Refresh dropdowns and colours', 'applySheetFormatting')
    .addItem('Recalculate agent workload', 'recalculateAgentLoad')
    .addToUi();
}

/**
 * Run this once by hand. An installable trigger is required because a simple
 * onEdit cannot move rows between sheets — that needs authorisation.
 */
function installTriggers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'onEditInstallable') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger('onEditInstallable')
    .forSpreadsheet(ss)
    .onEdit()
    .create();
  applySheetFormatting();
  SpreadsheetApp.getUi().alert(
    'Installed.\n\nChoosing ARCHIVED in the status column now moves that row to '
    + 'the Archive tab immediately.'
  );
}

/** Fires on every edit. Only acts when status becomes ARCHIVED. */
function onEditInstallable(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    if (sheet.getName() !== CONV_TAB) return;
    if (e.range.getRow() < 2) return;

    var headers = headers_(sheet);
    var statusCol = headers.indexOf('status') + 1;
    if (statusCol <= 0 || e.range.getColumn() !== statusCol) return;

    if (String(e.range.getValue()).trim().toUpperCase() === 'ARCHIVED') {
      moveRowsToArchive_(sheet, [e.range.getRow()]);
    }
  } catch (err) {
    // Never let a trigger error block the user's edit.
    console.error('onEditInstallable: ' + err);
  }
}

/* ───────────────────────────── archiving ───────────────────────────── */

function archiveSelected() {
  var sheet = SpreadsheetApp.getActiveSheet();
  var ui = SpreadsheetApp.getUi();
  if (sheet.getName() !== CONV_TAB) {
    ui.alert('Switch to the Conversations tab first.');
    return;
  }
  var range = sheet.getActiveRange();
  var rows = [];
  for (var i = 0; i < range.getNumRows(); i++) {
    var r = range.getRow() + i;
    if (r >= 2) rows.push(r);
  }
  if (!rows.length) { ui.alert('Select one or more conversation rows first.'); return; }

  var moved = moveRowsToArchive_(sheet, rows);
  ui.alert(moved + ' conversation(s) moved to ' + ARCHIVE_TAB + '.');
}

/**
 * Move rows to the Archive tab.
 *
 * Rows are deleted in DESCENDING order because removing a row shifts every row
 * beneath it — deleting top-down would delete the wrong conversations. The
 * append happens before any delete, so a failure cannot lose data.
 */
function moveRowsToArchive_(sheet, rowNumbers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var archive = ss.getSheetByName(ARCHIVE_TAB);
  if (!archive) { archive = ss.insertSheet(ARCHIVE_TAB); }

  var convHeaders = headers_(sheet);
  var archHeaders = headers_(archive);

  // Give the archive a header the first time it is used.
  if (archHeaders.length === 0 || !archHeaders[0]) {
    archHeaders = convHeaders.concat(['archived_at']);
    archive.getRange(1, 1, 1, archHeaders.length).setValues([archHeaders]);
    archive.setFrozenRows(1);
  }

  var stamp = new Date().toISOString();
  var sorted = rowNumbers.slice().sort(function (a, b) { return b - a; });
  var moved = 0;

  for (var i = 0; i < sorted.length; i++) {
    var row = sorted[i];
    var values = sheet.getRange(row, 1, 1, convHeaders.length).getValues()[0];
    if (!values.join('')) continue;            // skip a blank row

    // Map by NAME, not position, so a future column reorder cannot scramble
    // the archive.
    var out = [];
    for (var c = 0; c < archHeaders.length; c++) {
      var name = archHeaders[c];
      if (name === 'archived_at') { out.push(stamp); continue; }
      var idx = convHeaders.indexOf(name);
      out.push(idx === -1 ? '' : values[idx]);
    }

    archive.appendRow(out);
    sheet.deleteRow(row);
    moved++;
  }
  return moved;
}

/* ───────────────────────────── formatting ───────────────────────────── */

function applySheetFormatting() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONV_TAB);
  if (!sheet) return;

  var headers = headers_(sheet);
  var col = function (n) { return headers.indexOf(n) + 1; };
  // Bound the validated range to real rows plus a small margin, for the same
  // reason: validation over a huge empty range pollutes it.
  var lastRow = Math.max(sheet.getLastRow() + 50, 60);

  // --- status dropdown ---
  var statusCol = col('status');
  if (statusCol > 0) {
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(STATUSES, true)
      .setAllowInvalid(false)
      .setHelpText('Pick a status. ARCHIVED moves the row to the Archive tab.')
      .build();
    sheet.getRange(2, statusCol, lastRow - 1, 1).setDataValidation(rule);
  }

  // --- agent dropdown, fed from the Agents tab ---
  // Built from the live list rather than hard-coded, so adding an agent to
  // the Agents tab is the only step needed.
  var agentCol = col('assigned_agent_name');
  var agents = agentNames_();
  if (agentCol > 0 && agents.length) {
    var agentRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(agents, true)
      .setAllowInvalid(true)   // the system may write a name before it is listed
      .setHelpText('Agent handling this conversation. Names come from the Agents tab.')
      .build();
    sheet.getRange(2, agentCol, lastRow - 1, 1).setDataValidation(agentRule);
  }

  // --- colour the row by status ---
  var rules = [];
  var all = sheet.getRange(2, 1, lastRow - 1, headers.length);
  var sL = columnLetter_(statusCol);
  for (var st in STATUS_COLORS) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$' + sL + '2="' + st + '"')
      .setBackground(STATUS_COLORS[st])
      .setRanges([all])
      .build());
  }

  // Waiting more than an hour with no reply: the SLA risk.
  var fmCol = col('first_message_at');
  if (statusCol > 0 && fmCol > 0) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($' + sL + '2="UNANSWERED",NOW()-$'
                            + columnLetter_(fmCol) + '2>1/24)')
      .setBackground('#e06666').setFontColor('#ffffff').setBold(true)
      .setRanges([all]).build());
  }

  // A reply typed but not yet sent.
  var rtCol = col('reply_text'), rsCol = col('reply_status');
  if (rtCol > 0 && rsCol > 0) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($' + columnLetter_(rtCol) + '2<>"",$'
                            + columnLetter_(rsCol) + '2="")')
      .setBackground('#c9daf8')
      .setRanges([sheet.getRange(2, rtCol, lastRow - 1, 1)])
      .build());
  }
  sheet.setConditionalFormatRules(rules);

  // --- header, widths, wrapping ---
  sheet.getRange(1, 1, 1, headers.length)
    .setBackground('#26404f').setFontColor('#ffffff')
    .setFontWeight('bold').setVerticalAlignment('middle');
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 34);
  // Freeze the identity columns so they stay visible when scrolling right.
  sheet.setFrozenColumns(Math.min(2, headers.length));

  var widths = {
    customer_name: 150, customer_phone: 130, assigned_agent_name: 140,
    status: 170, product: 160, quantity: 80,
    first_message_at: 160, last_activity_at: 160,
    last_message: 320, wa_link: 190, reply_text: 280
  };
  for (var name in widths) {
    var c = col(name);
    if (c > 0) sheet.setColumnWidth(c, widths[name]);
  }
  ['last_message', 'reply_text', 'product'].forEach(function (n) {
    var c = col(n);
    if (c > 0) sheet.getRange(2, c, lastRow - 1, 1)
      .setWrap(true).setVerticalAlignment('top');
  });

  // Hide the technical tail — nothing is deleted, unhide any time.
  ['conversation_id', 'business_phone_number_id', 'last_message_id',
   'last_message_direction', 'reply_error', 'unassigned_reason',
   'assigned_agent_id'].forEach(function (n) {
    var c = col(n);
    if (c > 0) sheet.hideColumns(c);
  });

  // Agents tab: checkboxes, because the routing engine fails CLOSED on any
  // value it does not recognise — a typed "yes" would silently unroute someone.
  //
  // Applied ONLY to rows that actually hold an agent. A BOOLEAN rule over a
  // large empty range makes Sheets write FALSE into every blank cell, which
  // then reads back as hundreds of phantom rows. That happened once; this is
  // the fix.
  var ag = ss.getSheetByName(AGENTS_TAB);
  if (ag) {
    var ah = headers_(ag);
    var agentRows = Math.max(agentNames_().length, 1);
    ['active', 'available'].forEach(function (n) {
      var c = ah.indexOf(n) + 1;
      if (c > 0) ag.getRange(2, c, agentRows, 1).insertCheckboxes();
    });
    ag.getRange(1, 1, 1, ah.length)
      .setBackground('#26404f').setFontColor('#ffffff').setFontWeight('bold');
    ag.setFrozenRows(1);
  }
}

/* ───────────────────────────── actions ───────────────────────────── */

function replyToSelected() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== CONV_TAB) { ui.alert('Select a row on the Conversations tab first.'); return; }

  var row = sheet.getActiveRange().getRow();
  if (row < 2) { ui.alert('Select a conversation row, not the header.'); return; }

  var h = headers_(sheet);
  var who = sheet.getRange(row, h.indexOf('customer_name') + 1).getValue()
         || sheet.getRange(row, h.indexOf('customer_phone') + 1).getValue();

  var res = ui.prompt('Reply to ' + who,
    'Sent over WhatsApp within about a minute.', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;

  var text = res.getResponseText().trim();
  if (!text) { ui.alert('Nothing sent — the message was empty.'); return; }
  if (text.length > 4096) { ui.alert('Too long: ' + text.length + ' characters (limit 4096).'); return; }

  sheet.getRange(row, h.indexOf('reply_text') + 1).setValue(text);
  // Clearing reply_status is what marks it pending for the sender workflow.
  sheet.getRange(row, h.indexOf('reply_status') + 1).setValue('');
  ui.alert('Queued. Watch the reply_status column.');
}

function openWhatsAppChat() {
  var sheet = SpreadsheetApp.getActiveSheet();
  var row = sheet.getActiveRange().getRow();
  if (sheet.getName() !== CONV_TAB || row < 2) {
    SpreadsheetApp.getUi().alert('Select a conversation row first.');
    return;
  }
  var link = sheet.getRange(row, headers_(sheet).indexOf('wa_link') + 1).getValue();
  if (!link) { SpreadsheetApp.getUi().alert('No WhatsApp link on this row.'); return; }

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(
      '<p><a href="' + link + '" target="_blank" rel="noopener">' + link + '</a></p>' +
      '<p style="color:#666;font-size:12px">Replying from a <b>personal</b> WhatsApp ' +
      'account is not tracked. Use the Reply menu item so the reply is recorded.</p>' +
      '<script>window.open("' + link + '","_blank");</script>'
    ).setWidth(430).setHeight(180), 'WhatsApp');
}

/**
 * Rebuild open_conversations from the conversations themselves.
 * The counter is denormalized so it can drift; this is the repair.
 */
function recalculateAgentLoad() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var conv = ss.getSheetByName(CONV_TAB);
  var ag = ss.getSheetByName(AGENTS_TAB);
  if (!conv || !ag) { SpreadsheetApp.getUi().alert('Conversations or Agents tab missing.'); return; }

  var ch = headers_(conv);
  var idIdx = ch.indexOf('assigned_agent_id');
  var stIdx = ch.indexOf('status');
  var counts = {};
  var data = conv.getDataRange().getValues();
  for (var r = 1; r < data.length; r++) {
    var id = String(data[r][idIdx] || '').trim();
    var st = String(data[r][stIdx] || '').trim().toUpperCase();
    if (!id || st === 'CLOSED' || st === 'ARCHIVED' || st === '') continue;
    counts[id] = (counts[id] || 0) + 1;
  }

  var ah = headers_(ag);
  var aId = ah.indexOf('agent_id');
  var aOpen = ah.indexOf('open_conversations') + 1;
  var rows = ag.getDataRange().getValues();
  var changes = [];
  for (var i = 1; i < rows.length; i++) {
    var gid = String(rows[i][aId] || '').trim();
    if (!gid) continue;
    var actual = counts[gid] || 0;
    var stored = Number(rows[i][aOpen - 1] || 0);
    if (actual !== stored) {
      ag.getRange(i + 1, aOpen).setValue(actual);
      changes.push(gid + ': ' + stored + ' -> ' + actual);
    }
  }
  SpreadsheetApp.getUi().alert(changes.length
    ? 'Corrected ' + changes.length + ' counter(s):\n\n' + changes.join('\n')
    : 'All agent counters were already correct.');
}

/* ───────────────────────────── helpers ───────────────────────────── */

function headers_(sheet) {
  var last = sheet.getLastColumn();
  if (last < 1) return [];
  return sheet.getRange(1, 1, 1, last).getValues()[0].map(String);
}

function agentNames_() {
  var ag = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AGENTS_TAB);
  if (!ag) return [];
  var h = headers_(ag);
  var nameIdx = h.indexOf('name');
  if (nameIdx === -1) return [];
  var out = [];
  var rows = ag.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var n = String(rows[i][nameIdx] || '').trim();
    if (n && out.indexOf(n) === -1) out.push(n);
  }
  return out;
}

function columnLetter_(index) {
  var s = '';
  while (index > 0) {
    var r = (index - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    index = Math.floor((index - 1) / 26);
  }
  return s;
}
