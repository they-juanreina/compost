import Foundation

// Mirrors the `events` table (provenance/src/migrations/0001_init.sql) and the
// Snapshot shape produced by provenance/src/reducer.ts. WRITES never touch this —
// the app only READS the ledger and reduces it (ADR 0003 §4). Mutations go
// through the CLI, which appends the canonical events.

public enum Action: String, Codable, Sendable {
    case create, update, endorse, reject, link, unlink
}

/// One row of `.compost/events.sqlite`. `payload` is the parsed TEXT column.
public struct EventRow: Sendable, Hashable {
    public let id: String            // ULID — ts-prefixed, so id-ascending == chronological
    public let ts: String            // ISO 8601
    public let artifactKind: String
    public let artifactId: String    // sha256 of the artifact's initial state
    public let action: Action
    public let actorType: String     // researcher | agent | ai
    public let actorId: String
    public let payload: JSONValue

    public init(id: String, ts: String, artifactKind: String, artifactId: String,
                action: Action, actorType: String, actorId: String, payload: JSONValue) {
        self.id = id; self.ts = ts; self.artifactKind = artifactKind
        self.artifactId = artifactId; self.action = action
        self.actorType = actorType; self.actorId = actorId; self.payload = payload
    }
}

/// Folded current state of one artifact — 1:1 with reducer.ts `Snapshot`.
public struct Snapshot: Sendable, Hashable {
    public var artifactKind: String
    public var artifactId: String
    public var currentState: [String: JSONValue]
    public var version: Int
    public var lastEvent: String
    public var humanApproved: Bool
    public var archived: Bool
}

/// A minimal Codable JSON value so an arbitrary `payload` round-trips faithfully.
public enum JSONValue: Codable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    /// Parse a JSON string (the DB TEXT column) into a value; non-JSON → .string.
    public static func parse(_ text: String) -> JSONValue {
        guard let data = text.data(using: .utf8) else { return .string(text) }
        return (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .string(text)
    }

    public var asObject: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }
    public var asString: String? {
        if case .string(let s) = self { return s }
        return nil
    }
}
