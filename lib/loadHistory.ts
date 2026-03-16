/**
 * Load history utilities.
 * Handles snapshot capture, history recording, and undo for data loads.
 */

import type {
  Application,
  LoadHistoryEntry,
  LoadHistoryDataSnapshot,
  LoadSourceType,
  LoadHistorySourceData,
} from "./types";

const MAX_HISTORY_ENTRIES = 15;
const MAX_CSV_ROWS_STORED = 500;

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Deep-clone the mutable data arrays from an Application for snapshot storage.
 * Only clones the data that changes during loads — not config, narratives, chats, etc.
 */
export function captureDataSnapshot(app: Application): LoadHistoryDataSnapshot {
  return JSON.parse(
    JSON.stringify({
      submissions: app.submissions,
      questions: app.questions,
      financial_records: app.financial_records,
      call_results: app.call_results,
      bookings: app.bookings,
      pending_webhook_submissions: app.pending_webhook_submissions,
    })
  );
}

/**
 * Add a load history entry to an application.
 * Caps history at MAX_HISTORY_ENTRIES, dropping oldest entries.
 * Omits csv_rows from source_data if too large.
 */
export function addLoadHistoryEntry(
  app: Application,
  sourceType: LoadSourceType,
  description: string,
  recordCount: number,
  preSnapshot: LoadHistoryDataSnapshot,
  sourceData?: LoadHistorySourceData
): Application {
  // Cap csv_rows to prevent storage bloat
  let sanitizedSourceData = sourceData;
  if (sourceData?.csv_rows && sourceData.csv_rows.length > MAX_CSV_ROWS_STORED) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { csv_rows, ...rest } = sourceData;
    sanitizedSourceData = rest;
  }

  const entry: LoadHistoryEntry = {
    id: uid(),
    timestamp: new Date().toISOString(),
    source_type: sourceType,
    description,
    record_count: recordCount,
    pre_load_snapshot: preSnapshot,
    source_data: sanitizedSourceData,
  };

  const history = [...(app.load_history ?? []), entry];

  // Trim oldest entries to stay within cap
  while (history.length > MAX_HISTORY_ENTRIES) {
    history.shift();
  }

  return { ...app, load_history: history };
}

/**
 * Undo a load by restoring the pre-load snapshot.
 * Removes the target entry and all entries after it (since they depend on this load).
 */
export function undoLoadHistoryEntry(
  app: Application,
  entryId: string
): Application {
  const history = app.load_history ?? [];
  const entryIndex = history.findIndex((e) => e.id === entryId);
  if (entryIndex < 0) return app;

  const entry = history[entryIndex];
  const snapshot = entry.pre_load_snapshot;

  // Restore data arrays from the snapshot
  const restored: Application = {
    ...app,
    submissions: snapshot.submissions,
    questions: snapshot.questions ?? app.questions,
    financial_records: snapshot.financial_records,
    call_results: snapshot.call_results,
    bookings: snapshot.bookings,
    pending_webhook_submissions: snapshot.pending_webhook_submissions,
    // Remove this entry and all subsequent entries
    load_history: history.slice(0, entryIndex),
  };

  return restored;
}
