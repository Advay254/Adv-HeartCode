// v1.1.4: extracted from routes/adminLanding.js so there's exactly ONE
// "swap this row's display_order with its neighbor" implementation in the
// codebase, matching this project's existing convention (see
// lib/slugify.js's own extraction history) rather than a second
// near-identical copy landing here for the new Categories admin page.
// routes/adminLanding.js now imports this instead of defining it locally —
// its own behavior (and the /steps/:id/move, /footer-links/:id/move
// routes built on it) is completely unchanged.

/**
 * Swaps `id`'s display_order with its immediate neighbor in the requested
 * direction — the simplest reordering mechanism that works without any
 * drag-and-drop library, matching this whole admin's no-fancy-JS-libraries,
 * works-on-a-phone constraint. Transactional (both rows locked and updated
 * together) so two concurrent reorder clicks can't leave two rows with the
 * same display_order.
 *
 * `table` is always a hardcoded string literal supplied by the caller
 * (never user input) — interpolating it directly into the query text is
 * safe on that basis, same as every other caller-controlled-table-name
 * query already in this codebase.
 */
async function moveItem(pool, table, id, direction) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    if (currentResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: 'not_found' };
    }
    const current = currentResult.rows[0];

    const comparator = direction === 'up' ? '<' : '>';
    const order = direction === 'up' ? 'DESC' : 'ASC';
    const neighborResult = await client.query(
      `SELECT * FROM ${table} WHERE display_order ${comparator} $1 ORDER BY display_order ${order} LIMIT 1 FOR UPDATE`,
      [current.display_order]
    );
    if (neighborResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: 'no_neighbor' };
    }
    const neighbor = neighborResult.rows[0];

    await client.query(`UPDATE ${table} SET display_order = $1 WHERE id = $2`, [neighbor.display_order, current.id]);
    await client.query(`UPDATE ${table} SET display_order = $1 WHERE id = $2`, [current.display_order, neighbor.id]);
    await client.query('COMMIT');
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { moveItem };
