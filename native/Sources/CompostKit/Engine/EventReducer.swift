import Foundation

// Verbatim port of provenance/src/reducer.ts. Pure: no I/O, no clock.
// Same inputs → same output. The golden test in CompostKitTests pins this
// against `compost blame --json` to keep the port honest (the spike's #3 risk).

public enum EventReducer {

    public struct ArtifactMismatch: Error { public let message: String }

    /// Apply a single event to an in-flight snapshot.
    /// The event MUST belong to the same (artifactKind, artifactId) as the snapshot.
    public static func apply(_ snapshot: Snapshot?, _ event: EventRow) throws -> Snapshot {
        if let s = snapshot,
           s.artifactKind != event.artifactKind || s.artifactId != event.artifactId {
            throw ArtifactMismatch(message:
                "apply: artifact mismatch — snapshot is \(s.artifactKind)/\(s.artifactId), event is \(event.artifactKind)/\(event.artifactId)")
        }

        let base = snapshot ?? Snapshot(
            artifactKind: event.artifactKind,
            artifactId: event.artifactId,
            currentState: [:],
            version: 0,
            lastEvent: "",
            humanApproved: false,
            archived: false
        )

        switch event.action {
        case .create, .link:
            var next = base
            next.currentState = payloadAsObject(event.payload)
            next.humanApproved = event.actorType == "researcher"
            next.archived = false
            next.version = base.version + 1
            next.lastEvent = event.id
            return next

        case .update:
            var next = base
            next.currentState = mergeUpdate(base.currentState, event.payload)
            next.version = base.version + 1
            next.lastEvent = event.id
            return next

        case .endorse:
            var endorsement: [String: JSONValue] = [
                "endorsed_at": .string(event.ts),
                "endorsed_by": .string(event.actorId),
            ]
            if let o = event.payload.asObject {
                for (k, v) in o { endorsement[k] = v }
            }
            var next = base
            next.currentState["_endorsement"] = .object(endorsement)
            next.humanApproved = true
            next.version = base.version + 1
            next.lastEvent = event.id
            return next

        case .reject, .unlink:
            var next = base
            next.currentState["_archive_reason"] =
                event.payload.asObject != nil ? event.payload : .object(["note": .string(stringify(event.payload))])
            next.currentState["_archived_at"] = .string(event.ts)
            next.currentState["_archived_by"] = .string(event.actorId)
            next.humanApproved = false
            next.archived = true
            next.version = base.version + 1
            next.lastEvent = event.id
            return next
        }
    }

    /// Reduce a chronologically-ordered event list for ONE artifact to its snapshot.
    /// Caller sorts by id (ULID is ts-prefixed) ascending.
    public static func reduce(_ events: [EventRow]) throws -> Snapshot? {
        guard !events.isEmpty else { return nil }
        var snapshot: Snapshot? = nil
        for e in events { snapshot = try apply(snapshot, e) }
        return snapshot
    }

    /// Group a flat ledger by artifact, sort each group by id, reduce each.
    /// Convenience over reduce() for rendering a whole kind (e.g. highlights).
    public static func reduceAll(_ rows: [EventRow]) throws -> [Snapshot] {
        var byArtifact: [String: [EventRow]] = [:]
        for r in rows {
            byArtifact["\(r.artifactKind)\u{0}\(r.artifactId)", default: []].append(r)
        }
        var out: [Snapshot] = []
        for (_, group) in byArtifact {
            let sorted = group.sorted { $0.id < $1.id }
            if let snap = try reduce(sorted) { out.append(snap) }
        }
        return out
    }

    // MARK: - payload helpers (mirror reducer.ts)

    private static func payloadAsObject(_ payload: JSONValue) -> [String: JSONValue] {
        switch payload {
        case .object(let o): return o
        case .null: return [:]
        default: return ["value": payload]
        }
    }

    private static func mergeUpdate(_ current: [String: JSONValue], _ payload: JSONValue) -> [String: JSONValue] {
        // Field-level patch { field, after } → set one key.
        if case .object(let o) = payload,
           case .string(let field)? = o["field"],
           let after = o["after"] {
            var next = current
            next[field] = after
            return next
        }
        // Full-object payload → shallow merge.
        if case .object(let o) = payload {
            var next = current
            for (k, v) in o { next[k] = v }
            return next
        }
        return current
    }

    /// Approximates JS String(payload) for the non-object archive-reason branch.
    private static func stringify(_ v: JSONValue) -> String {
        switch v {
        case .string(let s): return s
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        case .number(let n):
            return n == n.rounded() ? String(Int(n)) : String(n)
        case .array, .object:
            let enc = JSONEncoder()
            if let d = try? enc.encode(v), let s = String(data: d, encoding: .utf8) { return s }
            return ""
        }
    }
}
