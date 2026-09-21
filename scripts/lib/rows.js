/**
 * Row bookkeeping for the one place that deletes rows: the archive.
 *
 * Deleting a row shifts every row below it up by one. The archive used to
 * delete by the row_number it read at the start of the run, one request per
 * row, while other workflows kept writing. Here the delete is planned from a
 * read taken right before it, sent as one batch from the bottom up, and then
 * checked against a second read: an archived id still present is reported,
 * and a row that vanished without being archived is handed back to be
 * re-appended, from the copy read just before.
 *
 * Every function is pure: it takes what the Sheets API returned and says what
 * to do. Workflow 8 makes the calls.
 */

'use strict';

/**
 * One tab of a `spreadsheets.get` response made with includeGridData, as a
 * header and plain rows of strings.
 *
 * @param {object} response  The API response.
 * @param {string} title     The tab.
 * @returns {{sheetId:number, header:string[], rows:string[][]}|null}
 *          `rows[i]` is sheet row i + 2 (row 1 is the header). Null when the
 *          tab is not in the response, so a failed read is never mistaken for
 *          an empty tab.
 */
function readGrid(response, title) {
  const sheets = (response && response.sheets) || [];
  const sheet = sheets.find((s) => s && s.properties && s.properties.title === title);
  if (!sheet) return null;
  const data = (sheet.data || [])[0];
  if (!data) return null;
  const values = (data.rowData || []).map((r) =>
    ((r && r.values) || []).map((c) =>
      (c && c.formattedValue !== undefined && c.formattedValue !== null ? String(c.formattedValue) : '')));
  return {
    sheetId: sheet.properties.sheetId,
    header: (values[0] || []).map((h) => h.trim()),
    rows: values.slice(1),
  };
}

/**
 * Plan the deletion of every row carrying one of `ids`.
 *
 * A row is found by its id, in the grid read just now, never by a remembered
 * row number. Every row carrying the id is deleted: two rows with one id are
 * two copies of the same conversation, and it was archived. Requests run from
 * the bottom up, so each delete only shifts rows that were already handled.
 *
 * @param {object}   grid      From readGrid.
 * @param {string[]} ids       Conversation ids that were copied to the Archive.
 * @param {string}   [column]  The id column, default conversation_id.
 * @returns {{requests:object[], deleted:string[], missing:string[], repeated:string[], error?:string}}
 */
function planDeletes(grid, ids, column) {
  const wanted = (ids || []).map((id) => String(id || '').trim()).filter(Boolean);
  const empty = { requests: [], deleted: [], missing: wanted.slice(), repeated: [] };
  if (!grid) return Object.assign(empty, { error: 'no_grid' });
  const col = grid.header.indexOf(column || 'conversation_id');
  if (col === -1) return Object.assign(empty, { error: 'no_id_column' });

  const want = new Set(wanted);
  const hits = [];
  grid.rows.forEach((row, i) => {
    const id = String(row[col] || '').trim();
    if (id && want.has(id)) hits.push({ id, index: i + 1 }); // grid index 0 is the header
  });

  const counts = {};
  for (const h of hits) counts[h.id] = (counts[h.id] || 0) + 1;
  const found = Object.keys(counts);

  hits.sort((a, b) => b.index - a.index);
  return {
    requests: hits.map((h) => ({
      deleteDimension: {
        range: { sheetId: grid.sheetId, dimension: 'ROWS', startIndex: h.index, endIndex: h.index + 1 },
      },
    })),
    deleted: found,
    missing: wanted.filter((id) => !counts[id]),
    repeated: found.filter((id) => counts[id] > 1),
  };
}

/**
 * Compare the tab before and after the delete.
 *
 * @param {object}   before      From readGrid, the read the plan was made from.
 * @param {object}   after       From readGrid, read after the delete.
 * @param {string[]} deletedIds  The ids the plan deleted.
 * @param {string}   [column]    The id column, default conversation_id.
 * @returns {{stillPresent:string[], lost:Array<{id:string,row:object}>, error?:string}}
 *   `lost` holds rows that were there before, were not meant to be deleted,
 *   and are gone: a delete that landed on the wrong row. Each carries its
 *   values by column name, ready to be appended back. Anything that does not
 *   look like a misplaced delete (no id column, or lost rows not matched one
 *   for one by archived rows still present) restores nothing and says so,
 *   rather than re-appending rows that may still be there.
 */
function checkDeletes(before, after, deletedIds, column) {
  const key = column || 'conversation_id';
  if (!before || !after) return { stillPresent: [], lost: [], error: 'no_grid' };
  const bCol = before.header.indexOf(key);
  const aCol = after.header.indexOf(key);
  if (bCol === -1 || aCol === -1) return { stillPresent: [], lost: [], error: 'no_id_column' };

  const deleted = new Set((deletedIds || []).map(String));
  const afterIds = new Set(after.rows.map((r) => String(r[aCol] || '').trim()).filter(Boolean));

  const stillPresent = Array.from(deleted).filter((id) => afterIds.has(id));

  const lost = [];
  const seen = new Set();
  for (const row of before.rows) {
    const id = String(row[bCol] || '').trim();
    if (!id || deleted.has(id) || afterIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    const values = {};
    before.header.forEach((h, i) => {
      if (h) values[h] = row[i] === undefined ? '' : row[i];
    });
    lost.push({ id, row: values });
  }

  // A delete that lands on the wrong row does two things at once: it removes
  // a row it should not have, and it leaves the row it meant behind. So every
  // genuinely lost row is matched by one archived id still present. Anything
  // else (an empty or truncated second read, a row someone deleted by hand)
  // is not a misplaced delete, and re-appending would duplicate rows that are
  // still there.
  if (lost.length > 0 && lost.length !== stillPresent.length) {
    return {
      stillPresent,
      lost: [],
      error: 'implausible_loss:lost=' + lost.length + ',missed=' + stillPresent.length,
    };
  }
  return { stillPresent, lost };
}

module.exports = { readGrid, planDeletes, checkDeletes };
