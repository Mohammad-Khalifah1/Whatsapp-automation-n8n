/**
 * WhatsApp Support Routing — one-click Google Sheets setup.
 *
 * WHAT THIS DOES
 * --------------
 * Builds the entire spreadsheet the system expects: every tab, every column,
 * frozen headers, dropdown validation, colour rules, filter views, and a
 * "WhatsApp Support" menu with a Reply box.
 *
 * HOW TO INSTALL
 * --------------
 *   1. Open your Google Sheet
 *   2. Extensions -> Apps Script
 *   3. Delete anything in the editor, paste this whole file, Save
 *   4. Run -> setupEverything   (approve the permission prompt once)
 *   5. Reload the sheet. A "WhatsApp Support" menu appears.
 *
 * SAFE TO RE-RUN. Existing data is never deleted: tabs that already exist keep
 * their rows, and only headers, formatting and validation are refreshed.
 */

/* ────────────────────────────────────────────────────────────────────────
   Schema — must match docs/GOOGLE_SHEETS_SCHEMA.md and the n8n workflows.
   Column names are how the workflows address data, so a typo here breaks
   writes silently.
   ──────────────────────────────────────────────────────────────────────── */

var SCHEMA = {
  Agents: [
    'agent_id', 'name', 'phone', 'active', 'available',
    'max_open_conversations', 'open_conversations', 'last_assigned_at',
    'role', 'working_hours', 'timezone', 'created_at', 'updated_at'
  ],
  Conversations: [
    'customer_name', 'customer_phone', 'assigned_agent_name', 'status',
    'unanswered_count', 'unanswered_messages', 'last_message',
    'last_message_type', 'last_message_direction', 'product', 'quantity',
    'first_message_at', 'last_activity_at', 'reply_text', 'reply_status',
    'unread', 'last_reply_via', 'wa_link', 'conversation_id', 'assigned_agent_id',
    'business_phone_number_id', 'last_message_id',
    'last_customer_message_at', 'last_agent_message_at', 'created_at',
    'updated_at', 'closed_at', 'unassigned_reason', 'reply_error',
    'reply_sent_at', 'reply_blocked_hash', 'first_reply_at'
  ],
  Messages: [
    'status', 'direction', 'customer_phone', 'recipient_phone',
    'message_type', 'text', 'timestamp', 'status_updated_at',
    'pricing_category', 'billable', 'agent_id',
    'sent_via', 'supported', 'processing_status', 'message_id',
    'sender_phone', 'created_at', 'correlation_id', 'raw_event_reference',
    'conversation_id', 'dedupe_key'
  ],
  Log: [
    'event_id', 'event_type', 'conversation_id', 'message_id', 'source',
    'timestamp', 'status', 'error', 'details'
  ],
  // Routing configuration for the MVP workflow's classifier. Edited by the
  // business, never by the system — add a product line by adding a row.
  Categories: [
    'category_id', 'name', 'keywords', 'priority', 'active', 'notes'
  ]
};

/**
 * Starter categories, written ONLY into an empty Categories tab.
 *
 * These are request types, not product names, because every business has
 * different products but the same handful of reasons customers write in.
 * Replace them with your own product lines — that is the point of the tab.
 *
 * `priority` breaks ties: when a message matches keywords from two categories,
 * the LOWER number wins. Complaints are 5 so that "the price is wrong, I have a
 * problem" files as a complaint rather than a pricing enquiry. Keep the
 * catch-all last with a large number.
 */
var STARTER_CATEGORIES = [
  ['C-COMPLAINT', 'شكوى', 'شكوى,مشكلة,زعلان,سيء,ما وصل,تأخر,متأخر,رديء,complaint,problem,late,damaged', 5, true, 'أعلى أولوية — تكسر التعادل مع أي فئة أخرى'],
  ['C-SUPPORT', 'دعم فني', 'ما بشتغل,مابشتغل,عطل,خربان,صيانة,تركيب,اعطال,فحص,support,repair,install,broken,not working', 15, true, 'طلبات ما بعد البيع'],
  ['C-PRICE', 'استفسار سعر', 'سعر,اسعار,بكم,كم سعر,تسعيرة,عرض سعر,كلفة,price,cost,quote,how much', 20, true, 'أكثر نوع رسائل متوقع'],
  ['C-ORDER', 'طلب شراء', 'بدي اشتري,اشتري,اطلب,طلبية,شراء,حجز,order,buy,purchase,booking', 25, true, ''],
  ['C-DELIVERY', 'توصيل وشحن', 'توصيل,شحن,متى يوصل,وين الطلب,تتبع,delivery,shipping,tracking', 30, true, ''],
  ['C-WARRANTY', 'كفالة وإرجاع', 'كفالة,ضمان,ارجاع,استبدال,استرجاع,warranty,return,exchange,refund', 35, true, ''],
  ['C-GENERAL', 'استفسار عام', 'استفسار,سؤال,معلومات,دوام,عنوان,فرع,اوقات,info,question,address,hours', 90, true, 'شبكة أمان — ضعها آخر أولوية دائماً']
];

var CONVERSATION_STATUSES = [
  'WAITING_FOR_AGENT', 'UNANSWERED', 'REPLIED', 'WAITING_FOR_CUSTOMER', 'CLOSED'
];

/** Colours chosen so status is readable at a glance without reading text. */
var STATUS_COLORS = {
  WAITING_FOR_AGENT: '#f4c7c3',   // red    — nobody owns this
  UNANSWERED:        '#fce8b2',   // amber  — customer is waiting
  REPLIED:           '#d9ead3',   // green  — ball in customer's court
  WAITING_FOR_CUSTOMER: '#d9ead3',
  CLOSED:            '#efefef'    // grey   — done
};

/* ────────────────────────────────────────────────────────────────────────
   Entry point
   ──────────────────────────────────────────────────────────────────────── */

function setupEverything() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var report = [];

  // Core tabs
  for (var name in SCHEMA) {
    report.push(ensureSheet_(ss, name, SCHEMA[name]));
  }

  // Archive tabs mirror their source plus archived_at.
  // One Archive tab, not one per source: fewer tabs is easier to work in,
  // and only conversations are archived on a schedule.
  report.push(ensureSheet_(ss, 'Archive',
      SCHEMA.Conversations.concat(['archived_at'])));

  report.push(seedCategories_(ss));

  applyConversationRules_(ss);
  applyAgentRules_(ss);
  createFilterViews_(ss);
  protectSystemColumns_(ss);
  report.push(buildDashboard_(ss));

  SpreadsheetApp.getUi().alert(
    'Setup complete\n\n' + report.join('\n') +
    '\n\nReload the page to see the "WhatsApp Support" menu.'
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Tab creation
   ──────────────────────────────────────────────────────────────────────── */

function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  var created = false;

  if (!sheet) {
    sheet = ss.insertSheet(name);
    created = true;
  }

  // Widen if the sheet has fewer columns than the schema needs.
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(),
        headers.length - sheet.getMaxColumns());
  }

  // Write headers. Existing DATA rows are untouched — only row 1 is rewritten,
  // so re-running this never destroys conversations.
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  sheet.getRange(1, 1, 1, headers.length)
       .setFontWeight('bold')
       .setBackground('#434343')
       .setFontColor('#ffffff')
       .setVerticalAlignment('middle');

  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 34);

  return (created ? 'Created  ' : 'Updated  ') + name +
         ' (' + headers.length + ' columns)';
}

/**
 * Write the starter categories, but ONLY into a tab that has no data rows.
 *
 * Re-running setupEverything must never overwrite categories the business has
 * tuned — that would silently undo their work and change how every future
 * message is classified. An empty tab is the only safe case.
 */
function seedCategories_(ss) {
  var sheet = ss.getSheetByName('Categories');
  if (!sheet) return 'Skipped  Categories (tab missing)';

  if (sheet.getLastRow() > 1) {
    return 'Kept     Categories (' + (sheet.getLastRow() - 1) + ' existing rows untouched)';
  }

  sheet.getRange(2, 1, STARTER_CATEGORIES.length, SCHEMA.Categories.length)
       .setValues(STARTER_CATEGORIES);

  // `active` as a real checkbox: typed text here silently disables a category.
  sheet.getRange(2, SCHEMA.Categories.indexOf('active') + 1,
                 Math.max(sheet.getMaxRows() - 1, 1), 1).insertCheckboxes();

  sheet.setColumnWidth(SCHEMA.Categories.indexOf('keywords') + 1, 420);
  sheet.setFrozenRows(1);

  return 'Seeded   Categories (' + STARTER_CATEGORIES.length + ' starter rows)';
}

/* ────────────────────────────────────────────────────────────────────────
   Conversations: validation, colour rules, column widths
   ──────────────────────────────────────────────────────────────────────── */

function applyConversationRules_(ss) {
  var sheet = ss.getSheetByName('Conversations');
  if (!sheet) return;

  var headers = SCHEMA.Conversations;
  var lastRow = Math.max(sheet.getMaxRows(), 1000);
  var col = function (n) { return headers.indexOf(n) + 1; };

  // --- status dropdown: stops typos creating states nothing filters on ---
  var statusRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(CONVERSATION_STATUSES, true)
      .setAllowInvalid(false)
      .setHelpText('Pick a status. Free text here breaks the manager filters.')
      .build();
  sheet.getRange(2, col('status'), lastRow - 1, 1).setDataValidation(statusRule);

  // --- unread as a real checkbox, not typed TRUE/FALSE ---
  sheet.getRange(2, col('unread'), lastRow - 1, 1).insertCheckboxes();

  // --- colour the whole row by status ---
  var rules = [];
  var range = sheet.getRange(2, 1, lastRow - 1, headers.length);
  var statusLetter = columnLetter_(col('status'));

  for (var status in STATUS_COLORS) {
    rules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=$' + statusLetter + '2="' + status + '"')
        .setBackground(STATUS_COLORS[status])
        .setRanges([range])
        .build()
    );
  }

  // Unanswered for more than an hour: make it impossible to miss.
  var lastCustLetter = columnLetter_(col('last_customer_message_at'));
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(
        '=AND($' + statusLetter + '2="UNANSWERED",' +
        'NOW()-$' + lastCustLetter + '2 > 1/24)')
      .setBackground('#e06666')
      .setFontColor('#ffffff')
      .setBold(true)
      .setRanges([range])
      .build()
  );

  // A reply waiting to be picked up by workflow 7.
  var replyLetter = columnLetter_(col('reply_text'));
  var replyStatusLetter = columnLetter_(col('reply_status'));
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($' + replyLetter + '2<>"",$' + replyStatusLetter + '2="")')
      .setBackground('#c9daf8')
      .setRanges([sheet.getRange(2, col('reply_text'), lastRow - 1, 1)])
      .build()
  );

  // A reply that failed to send.
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('FAILED')
      .setBackground('#cc0000')
      .setFontColor('#ffffff')
      .setRanges([sheet.getRange(2, col('reply_status'), lastRow - 1, 1)])
      .build()
  );

  sheet.setConditionalFormatRules(rules);

  // --- readable widths: the columns people actually look at ---
  sheet.setColumnWidth(col('last_message'), 320);
  sheet.setColumnWidth(col('reply_text'), 320);
  sheet.setColumnWidth(col('customer_name'), 160);
  sheet.setColumnWidth(col('customer_phone'), 140);
  sheet.setColumnWidth(col('status'), 170);
  sheet.setColumnWidth(col('wa_link'), 210);
  sheet.setColumnWidth(col('conversation_id'), 260);

  // Long text wraps instead of spilling across the screen.
  sheet.getRange(2, col('last_message'), lastRow - 1, 1)
       .setWrap(true).setVerticalAlignment('top');
  sheet.getRange(2, col('reply_text'), lastRow - 1, 1)
       .setWrap(true).setVerticalAlignment('top');

  // Hide the plumbing. Nothing is deleted — unhide any time.
  ['business_phone_number_id', 'last_message_id', 'reply_error']
    .forEach(function (h) {
      var c = col(h);
      if (c > 0) sheet.hideColumns(c);
    });
}

function applyAgentRules_(ss) {
  var sheet = ss.getSheetByName('Agents');
  if (!sheet) return;

  var headers = SCHEMA.Agents;
  var lastRow = Math.max(sheet.getMaxRows(), 200);
  var col = function (n) { return headers.indexOf(n) + 1; };

  // Checkboxes remove the whole class of "is 'yes' truthy?" problems.
  // The assignment engine fails closed on anything it does not recognise,
  // so a checkbox is not cosmetic — it prevents agents silently going unrouted.
  sheet.getRange(2, col('active'), lastRow - 1, 1).insertCheckboxes();
  sheet.getRange(2, col('available'), lastRow - 1, 1).insertCheckboxes();

  var capacityRule = SpreadsheetApp.newDataValidation()
      .requireNumberBetween(0, 100)
      .setAllowInvalid(false)
      .setHelpText('Maximum open conversations. 0 means this agent takes none.')
      .build();
  sheet.getRange(2, col('max_open_conversations'), lastRow - 1, 1)
       .setDataValidation(capacityRule);

  // open_conversations is system-owned; grey it so nobody edits it casually.
  sheet.getRange(2, col('open_conversations'), lastRow - 1, 1)
       .setBackground('#f3f3f3').setFontColor('#666666');

  // Highlight an agent who is at or over capacity.
  var openLetter = columnLetter_(col('open_conversations'));
  var maxLetter = columnLetter_(col('max_open_conversations'));
  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($' + openLetter + '2<>"",$' + openLetter + '2>=$' + maxLetter + '2)')
      .setBackground('#fce8b2')
      .setRanges([sheet.getRange(2, 1, lastRow - 1, headers.length)])
      .build()
  ]);
}

/* ────────────────────────────────────────────────────────────────────────
   Filter views — the manager's saved queries
   ──────────────────────────────────────────────────────────────────────── */

function createFilterViews_(ss) {
  var sheet = ss.getSheetByName('Conversations');
  if (!sheet) return;

  // Apps Script cannot create named filter *views*, so this applies a basic
  // filter. The named views are created once by hand — see the menu item
  // "Filter view instructions" for the exact recipe.
  try {
    var existing = sheet.getFilter();
    if (existing) existing.remove();
    sheet.getRange(1, 1, sheet.getMaxRows(), SCHEMA.Conversations.length)
         .createFilter();
  } catch (e) {
    // A filter already exists, or the sheet is protected. Not fatal.
  }
}

/* ────────────────────────────────────────────────────────────────────────
   Protection — warn before someone edits a system-owned column
   ──────────────────────────────────────────────────────────────────────── */

function protectSystemColumns_(ss) {
  var sheet = ss.getSheetByName('Conversations');
  if (!sheet) return;

  var headers = SCHEMA.Conversations;
  var systemCols = [
    'conversation_id', 'last_message', 'last_message_id',
    'last_customer_message_at', 'last_agent_message_at', 'last_activity_at',
    'created_at', 'updated_at', 'reply_status', 'reply_sent_at', 'category'
  ];

  // Warning-only, not a hard lock: a hard lock would also block the service
  // account, which must write these columns.
  systemCols.forEach(function (name) {
    var c = headers.indexOf(name) + 1;
    if (c <= 0) return;
    try {
      var p = sheet.getRange(2, c, sheet.getMaxRows() - 1, 1)
                   .protect()
                   .setDescription('System-owned: written by n8n');
      p.setWarningOnly(true);
    } catch (e) { /* already protected */ }
  });
}

/* ────────────────────────────────────────────────────────────────────────
   Menu
   ──────────────────────────────────────────────────────────────────────── */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('WhatsApp Support')
    .addItem('Reply to selected conversation…', 'replyToSelected')
    .addItem('Open WhatsApp chat for selected row', 'openWhatsAppChat')
    .addSeparator()
    .addItem('Mark selected as CLOSED', 'closeSelected')
    .addItem('Reopen selected', 'reopenSelected')
    .addSeparator()
    .addItem('Recalculate agent workload', 'recalculateAgentLoad')
    .addItem('Filter view instructions', 'showFilterInstructions')
    .addSeparator()
    .addItem('Re-run full setup', 'setupEverything')
    .addToUi();
}

/**
 * Type a reply in a dialog instead of hunting for the reply_text cell.
 * Writing the cell is all that is needed — workflow 7 picks it up within a
 * minute and sends it over the Cloud API.
 */
function replyToSelected() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();

  if (sheet.getName() !== 'Conversations') {
    ui.alert('Select a row on the Conversations tab first.');
    return;
  }

  var row = sheet.getActiveRange().getRow();
  if (row < 2) {
    ui.alert('Select a conversation row (not the header).');
    return;
  }

  var headers = SCHEMA.Conversations;
  var nameCol = headers.indexOf('customer_name') + 1;
  var phoneCol = headers.indexOf('customer_phone') + 1;
  var replyCol = headers.indexOf('reply_text') + 1;
  var statusCol = headers.indexOf('reply_status') + 1;

  var who = sheet.getRange(row, nameCol).getValue() ||
            sheet.getRange(row, phoneCol).getValue();

  var response = ui.prompt(
    'Reply to ' + who,
    'Your message will be sent over WhatsApp within about a minute.',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() !== ui.Button.OK) return;

  var text = response.getResponseText().trim();
  if (!text) { ui.alert('Nothing sent — the message was empty.'); return; }
  if (text.length > 4096) {
    ui.alert('Too long: ' + text.length + ' characters (limit is 4096).');
    return;
  }

  sheet.getRange(row, replyCol).setValue(text);
  // Clearing reply_status is what marks it as pending for workflow 7.
  sheet.getRange(row, statusCol).setValue('');

  ui.alert('Queued.\n\nIt will be sent within a minute. Watch the reply_status column.');
}

function openWhatsAppChat() {
  var sheet = SpreadsheetApp.getActiveSheet();
  var row = sheet.getActiveRange().getRow();
  if (sheet.getName() !== 'Conversations' || row < 2) {
    SpreadsheetApp.getUi().alert('Select a conversation row first.');
    return;
  }
  var linkCol = SCHEMA.Conversations.indexOf('wa_link') + 1;
  var link = sheet.getRange(row, linkCol).getValue();
  if (!link) { SpreadsheetApp.getUi().alert('No WhatsApp link on this row.'); return; }

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(
      '<p>Opening WhatsApp…</p>' +
      '<p><a href="' + link + '" target="_blank" rel="noopener">' + link + '</a></p>' +
      '<p style="color:#666;font-size:12px">Replying from a <b>personal</b> WhatsApp ' +
      'account is not tracked. Use the Reply menu item, or the WhatsApp Business App ' +
      'on the business number, so the reply is recorded.</p>' +
      '<script>window.open("' + link + '","_blank");</script>'
    ).setWidth(430).setHeight(210),
    'WhatsApp'
  );
}

function closeSelected() { setStatusOnSelection_('CLOSED'); }
function reopenSelected() { setStatusOnSelection_('UNANSWERED'); }

function setStatusOnSelection_(status) {
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== 'Conversations') {
    SpreadsheetApp.getUi().alert('Switch to the Conversations tab first.');
    return;
  }
  var headers = SCHEMA.Conversations;
  var statusCol = headers.indexOf('status') + 1;
  var closedCol = headers.indexOf('closed_at') + 1;
  var updatedCol = headers.indexOf('updated_at') + 1;
  var now = new Date().toISOString();

  var range = sheet.getActiveRange();
  var count = 0;

  for (var i = 0; i < range.getNumRows(); i++) {
    var row = range.getRow() + i;
    if (row < 2) continue;
    sheet.getRange(row, statusCol).setValue(status);
    sheet.getRange(row, closedCol).setValue(status === 'CLOSED' ? now : '');
    sheet.getRange(row, updatedCol).setValue(now);
    count++;
  }

  SpreadsheetApp.getUi().alert(count + ' conversation(s) set to ' + status + '.');
}

/**
 * Recompute open_conversations from the Conversations tab.
 *
 * The counter is denormalized, so it can drift — most often because two
 * conversations were assigned simultaneously (Google Sheets cannot make that
 * atomic). This restores the true value:
 *   count of non-CLOSED conversations per agent.
 */
function recalculateAgentLoad() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var convSheet = ss.getSheetByName('Conversations');
  var agentSheet = ss.getSheetByName('Agents');
  if (!convSheet || !agentSheet) {
    SpreadsheetApp.getUi().alert('Conversations or Agents tab is missing.');
    return;
  }

  var convHeaders = SCHEMA.Conversations;
  var agentIdCol = convHeaders.indexOf('assigned_agent_id');
  var statusCol = convHeaders.indexOf('status');

  var counts = {};
  var convData = convSheet.getDataRange().getValues();
  for (var r = 1; r < convData.length; r++) {
    var agentId = String(convData[r][agentIdCol] || '').trim();
    var status = String(convData[r][statusCol] || '').trim().toUpperCase();
    if (!agentId || status === 'CLOSED' || status === '') continue;
    counts[agentId] = (counts[agentId] || 0) + 1;
  }

  var aHeaders = SCHEMA.Agents;
  var aIdCol = aHeaders.indexOf('agent_id');
  var aOpenCol = aHeaders.indexOf('open_conversations') + 1;

  var agentData = agentSheet.getDataRange().getValues();
  var changes = [];

  for (var i = 1; i < agentData.length; i++) {
    var id = String(agentData[i][aIdCol] || '').trim();
    if (!id) continue;
    var actual = counts[id] || 0;
    var stored = Number(agentData[i][aOpenCol - 1] || 0);
    if (actual !== stored) {
      agentSheet.getRange(i + 1, aOpenCol).setValue(actual);
      changes.push(id + ': ' + stored + ' -> ' + actual);
    }
  }

  SpreadsheetApp.getUi().alert(
    changes.length === 0
      ? 'All agent counters were already correct.'
      : 'Corrected ' + changes.length + ' counter(s):\n\n' + changes.join('\n')
  );
}

function showFilterInstructions() {
  var html =
    '<div style="font-family:Arial,sans-serif;font-size:13px;line-height:1.6">' +
    '<p>Apps Script cannot create <b>named filter views</b>, so create these once by hand:</p>' +
    '<p><b>Data → Filter views → Create new filter view</b>, then set the filter and rename it.</p>' +
    '<table cellpadding="6" style="border-collapse:collapse">' +
    '<tr style="background:#eee"><th align="left">Name</th><th align="left">Filter</th></tr>' +
    '<tr><td><b>Needs attention</b></td><td>status is UNANSWERED or WAITING_FOR_AGENT<br>' +
    '<i>sort last_customer_message_at ascending</i></td></tr>' +
    '<tr><td><b>Unassigned</b></td><td>status = WAITING_FOR_AGENT</td></tr>' +
    '<tr><td><b>Unanswered</b></td><td>status = UNANSWERED</td></tr>' +
    '<tr><td><b>Open</b></td><td>status is not CLOSED</td></tr>' +
    '<tr><td><b>Closed</b></td><td>status = CLOSED</td></tr>' +
    '<tr><td><b>Waiting for customer</b></td><td>status = REPLIED</td></tr>' +
    '<tr><td><b>By agent</b></td><td>assigned_agent_name = (pick one)</td></tr>' +
    '<tr><td><b>Unread</b></td><td>unread is checked</td></tr>' +
    '<tr><td><b>Failed replies</b></td><td>reply_status = FAILED</td></tr>' +
    '</table>' +
    '<p style="color:#666">Filter <b>views</b> are per-person: yours does not change what ' +
    'anyone else sees. A plain filter does.</p>' +
    '</div>';
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(560).setHeight(460),
    'Recommended filter views'
  );
}

/** 1 -> A, 27 -> AA. Needed for conditional-format formulas. */
function columnLetter_(index) {
  var letter = '';
  while (index > 0) {
    var rem = (index - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    index = Math.floor((index - 1) / 26);
  }
  return letter;
}


/* ────────────────────────────────────────────────────────────────────────
   Dashboard — a manager's view, rebuilt from scratch on every run.

   Everything on this tab is a formula over the live tabs, so it is always
   current and there is nothing to refresh. It holds no data of its own, which
   is why it is safe to delete and rebuild: buildDashboard_ clears the sheet,
   re-writes the formulas, and re-inserts the charts.

   Column letters are derived from SCHEMA rather than hard-coded, so adding a
   column to Conversations cannot silently point a KPI at the wrong data.
   ──────────────────────────────────────────────────────────────────────── */

/** Palette — one place, so the whole tab stays consistent. */
var DASH = {
  ink:     '#202124',
  muted:   '#5f6368',
  rule:    '#e0e0e0',
  card:    '#f8f9fa',
  accent:  '#1a73e8',
  good:    '#188038',
  warn:    '#e37400',
  bad:     '#d93025',
  font:    'Google Sans',
  fontAlt: 'Arial'
};

/** A1 column letter for a named column of a tab in SCHEMA. */
function colOf_(tab, name) {
  var i = SCHEMA[tab].indexOf(name);
  if (i === -1) throw new Error('Dashboard: no column "' + name + '" in ' + tab);
  return columnLetter_(i + 1);
}

function buildDashboard_(ss) {
  var name = 'Dashboard';
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name, 0);
  ss.setActiveSheet(sh);
  ss.moveActiveSheet(1);

  // Rebuild from clean: drop old charts and contents.
  sh.getCharts().forEach(function (c) { sh.removeChart(c); });
  sh.clear();
  sh.clearConditionalFormatRules();
  if (sh.getMaxColumns() < 14) sh.insertColumnsAfter(sh.getMaxColumns(), 14 - sh.getMaxColumns());
  if (sh.getMaxRows() < 60) sh.insertRowsAfter(sh.getMaxRows(), 60 - sh.getMaxRows());

  sh.setHiddenGridlines(true);
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns())
    .setFontFamily(DASH.font).setFontColor(DASH.ink);

  var C = {
    status:   colOf_('Conversations', 'status'),
    agent:    colOf_('Conversations', 'assigned_agent_name'),
    product:  colOf_('Conversations', 'product'),
    qty:      colOf_('Conversations', 'quantity'),
    unread:   colOf_('Conversations', 'unread'),
    lastCust: colOf_('Conversations', 'last_customer_message_at'),
    firstAt:  colOf_('Conversations', 'first_message_at')
  };
  var M = {
    ts:  colOf_('Messages', 'timestamp'),
    dir: colOf_('Messages', 'direction')
  };
  var A = {
    name:      colOf_('Agents', 'name'),
    active:    colOf_('Agents', 'active'),
    available: colOf_('Agents', 'available')
  };

  /* ---- title ------------------------------------------------------- */
  sh.getRange('B2').setValue('WhatsApp Support')
    .setFontSize(22).setFontWeight('bold');
  sh.getRange('B3').setFormula(
      '="Live view · updated "&TEXT(NOW(),"d mmm yyyy, HH:mm")')
    .setFontSize(10).setFontColor(DASH.muted);
  sh.getRange('B4:M4').merge().setBackground(DASH.rule);
  sh.setRowHeight(4, 2);

  /* ---- KPI cards ---------------------------------------------------- */
  // label row, value row, one card every two columns
  var kpis = [
    ['Open conversations',
     '=COUNTIFS(Conversations!' + C.status + '2:' + C.status + ',"<>",Conversations!' +
        C.status + '2:' + C.status + ',"<>CLOSED",Conversations!' +
        C.status + '2:' + C.status + ',"<>ARCHIVED")', DASH.accent],
    ['Waiting for a reply',
     '=COUNTIF(Conversations!' + C.status + '2:' + C.status + ',"UNANSWERED")', DASH.warn],
    ['Nobody assigned',
     '=COUNTIF(Conversations!' + C.status + '2:' + C.status + ',"WAITING_FOR_AGENT")', DASH.bad],
    ['Messages today',
     '=COUNTIF(Messages!' + M.ts + '2:' + M.ts + ',TEXT(TODAY(),"yyyy-mm-dd")&"*")', DASH.ink],
    ['Agents on shift',
     '=COUNTIFS(Agents!' + A.active + '2:' + A.active + ',TRUE,Agents!' +
        A.available + '2:' + A.available + ',TRUE)', DASH.good],
    ['Unread',
     '=COUNTIF(Conversations!' + C.unread + '2:' + C.unread + ',TRUE)', DASH.muted]
  ];

  for (var i = 0; i < kpis.length; i++) {
    var c = 2 + i * 2;                       // B, D, F, H, J, L
    sh.getRange(6, c, 1, 2).merge().setValue(kpis[i][0])
      .setFontSize(9).setFontColor(DASH.muted)
      .setHorizontalAlignment('center').setVerticalAlignment('middle');
    sh.getRange(7, c, 1, 2).merge().setFormula(kpis[i][1])
      .setFontSize(26).setFontWeight('bold').setFontColor(kpis[i][2])
      .setHorizontalAlignment('center').setVerticalAlignment('middle');
    sh.getRange(6, c, 2, 2)
      .setBackground(DASH.card)
      .setBorder(true, true, true, true, false, false, DASH.rule,
                 SpreadsheetApp.BorderStyle.SOLID);
  }
  sh.setRowHeight(6, 22);
  sh.setRowHeight(7, 46);
  sh.setRowHeight(8, 14);

  /* ---- helper aggregation blocks, off to the right and hidden ------- */
  // P:Q  status   |  S:T  agent  |  V:W  product  |  Y:Z  last 14 days
  sh.getRange('P1').setValue('Status');
  sh.getRange('Q1').setValue('Conversations');
  var statuses = CONVERSATION_STATUSES;
  for (var k = 0; k < statuses.length; k++) {
    sh.getRange(2 + k, 16).setValue(statuses[k]);
    sh.getRange(2 + k, 17).setFormula(
      '=COUNTIF(Conversations!' + C.status + '2:' + C.status + ',"' + statuses[k] + '")');
  }

  sh.getRange('S1').setValue('Agent');
  sh.getRange('T1').setValue('Open');
  sh.getRange('S2').setFormula(
    '=IFERROR(FILTER(Agents!' + A.name + '2:' + A.name + ',Agents!' +
    A.name + '2:' + A.name + '<>""),"")');
  sh.getRange('T2').setFormula(
    '=IF(S2="","",ARRAYFORMULA(IF(S2:S="","",COUNTIFS(Conversations!' + C.agent + '2:' + C.agent +
    ',S2:S,Conversations!' + C.status + '2:' + C.status + ',"<>CLOSED",Conversations!' +
    C.status + '2:' + C.status + ',"<>ARCHIVED"))))');

  sh.getRange('V1').setValue('Product');
  sh.getRange('W1').setValue('Conversations');
  sh.getRange('V2').setFormula(
    '=IFERROR(QUERY(Conversations!' + C.product + '2:' + C.product +
    ',"select ' + C.product + ', count(' + C.product + ') where ' + C.product +
    " is not null group by " + C.product + ' order by count(' + C.product +
    ') desc limit 8 label count(' + C.product + ') \'\'",0),"")');

  sh.getRange('Y1').setValue('Day');
  sh.getRange('Z1').setValue('Messages');
  for (var d = 13; d >= 0; d--) {
    var row = 2 + (13 - d);
    sh.getRange(row, 25).setFormula('=TODAY()-' + d).setNumberFormat('d mmm');
    sh.getRange(row, 26).setFormula(
      '=COUNTIF(Messages!' + M.ts + '2:' + M.ts + ',TEXT(Y' + row + ',"yyyy-mm-dd")&"*")');
  }

  sh.getRange('P1:Z1').setFontWeight('bold').setFontColor(DASH.muted);

  /* ---- charts -------------------------------------------------------- */
  var charts = [
    { type: SpreadsheetApp.ChartType.LINE,   range: 'Y1:Z15', row: 10, col: 2,
      title: 'Messages, last 14 days', w: 620 },
    { type: SpreadsheetApp.ChartType.PIE,    range: 'P1:Q6',  row: 10, col: 9,
      title: 'Conversations by status', w: 420 },
    { type: SpreadsheetApp.ChartType.COLUMN, range: 'S1:T20', row: 28, col: 2,
      title: 'Open conversations per agent', w: 620 },
    { type: SpreadsheetApp.ChartType.BAR,    range: 'V1:W9',  row: 28, col: 9,
      title: 'What customers ask for', w: 420 }
  ];

  charts.forEach(function (c) {
    var b = sh.newChart()
      .setChartType(c.type)
      .addRange(sh.getRange(c.range))
      .setPosition(c.row, c.col, 0, 0)
      .setOption('title', c.title)
      .setOption('titleTextStyle', { fontName: DASH.font, fontSize: 13, bold: true, color: DASH.ink })
      .setOption('legend', { position: c.type === SpreadsheetApp.ChartType.PIE ? 'right' : 'none' })
      .setOption('backgroundColor', '#ffffff')
      .setOption('colors', [DASH.accent, DASH.good, DASH.warn, DASH.bad, DASH.muted])
      .setOption('width', c.w)
      .setOption('height', 260)
      .setOption('fontName', DASH.font);
    sh.insertChart(b.build());
  });

  /* ---- tidy ---------------------------------------------------------- */
  sh.setColumnWidth(1, 24);
  for (var w = 2; w <= 13; w++) sh.setColumnWidth(w, 96);
  sh.hideColumns(15, 12);              // O through Z: the helper blocks
  sh.setFrozenRows(4);

  return 'Built    Dashboard (6 KPIs, 4 charts)';
}
