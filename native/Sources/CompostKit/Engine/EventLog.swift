import Foundation
import SQLite3

// Read-only reader for `.compost/events.sqlite`. Opens with SQLITE_OPEN_READONLY
// so the app can NEVER mutate the ledger — every write goes through the CLI
// (ADR 0003 §4). The DB is WAL (journal_mode=wal), so this read handle coexists
// with a concurrently-running `compost watch` writer.

public struct EventLog: Sendable {
    public enum LogError: Error, CustomStringConvertible {
        case open(String)
        case prepare(String)
        public var description: String {
            switch self {
            case .open(let m): return "events.sqlite open failed: \(m)"
            case .prepare(let m): return "events.sqlite query failed: \(m)"
            }
        }
    }

    public let path: URL
    public init(path: URL) { self.path = path }

    /// Every row, ordered by id (ULID, ts-prefixed) ascending = chronological.
    public func allEvents() throws -> [EventRow] {
        var db: OpaquePointer?
        let rc = sqlite3_open_v2(path.path, &db, SQLITE_OPEN_READONLY, nil)
        guard rc == SQLITE_OK, let db else {
            let msg = db != nil ? String(cString: sqlite3_errmsg(db)) : "code \(rc)"
            sqlite3_close(db)
            throw LogError.open(msg)
        }
        defer { sqlite3_close(db) }

        let sql = """
        SELECT id, ts, artifact_kind, artifact_id, action, actor_type, actor_id, payload
        FROM events ORDER BY id ASC
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw LogError.prepare(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        func text(_ i: Int32) -> String {
            guard let c = sqlite3_column_text(stmt, i) else { return "" }
            return String(cString: c)
        }

        var rows: [EventRow] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let action = Action(rawValue: text(4)) else { continue } // defensively skip unknown actions
            rows.append(EventRow(
                id: text(0), ts: text(1), artifactKind: text(2), artifactId: text(3),
                action: action, actorType: text(5), actorId: text(6),
                payload: JSONValue.parse(text(7))
            ))
        }
        return rows
    }

    /// Reduced, non-archived snapshots for one artifact kind, most-recent first.
    public func snapshots(kind: String, includeArchived: Bool = false) throws -> [Snapshot] {
        let rows = try allEvents().filter { $0.artifactKind == kind }
        return try EventReducer.reduceAll(rows)
            .filter { includeArchived || !$0.archived }
            .sorted { $0.lastEvent > $1.lastEvent }
    }
}
