import Foundation

// Codable mirror of schema/transcript.schema.json (schema_version "1.0").
// We decode the canonical transcript.json directly — per ADR 0003, the on-disk
// JSON is the contract; reading it is not an engine operation, so no CLI hop.
// Only the fields the reader needs are modeled; everything optional decodes
// leniently so an extra field never breaks rendering.

public struct Transcript: Codable, Sendable {
    public let schemaVersion: String
    public let kind: String?
    public let status: String?
    public let sessionId: String
    public let source: String
    public let language: String
    public let durationMs: Int
    public let modality: [String]
    public let speakers: [Speaker]
    public let utterances: [Utterance]
    public let silences: [Silence]?
    public let cues: [Cue]?
    public let frames: [Frame]?

    /// Load + decode a transcript.json with snake_case → camelCase mapping.
    public static func load(contentsOf url: URL) throws -> Transcript {
        let data = try Data(contentsOf: url)
        let dec = JSONDecoder()
        dec.keyDecodingStrategy = .convertFromSnakeCase
        return try dec.decode(Transcript.self, from: data)
    }
}

public struct Speaker: Codable, Identifiable, Hashable, Sendable {
    public let id: String          // ^S[0-9]+$
    public let name: String?
    public let type: String        // moderator | participant | other
}

public struct Utterance: Codable, Identifiable, Hashable, Sendable {
    public let id: String          // ^U-[0-9]{4,}$
    public let speakerId: String
    public let turn: Int
    public let startMs: Int
    public let endMs: Int
    public let text: String
    public let prosody: Prosody?
    public let diarization: Diarization?
    public let annotation: String?
}

public struct Prosody: Codable, Hashable, Sendable {
    public let volume: String?     // low | normal | high
    public let pace: String?       // slow | normal | fast
    public let hesitations: Int?
}

public struct Diarization: Codable, Hashable, Sendable {
    public let confidence: Double?
}

public struct Silence: Codable, Identifiable, Hashable, Sendable {
    public let id: String          // ^SIL-[0-9]{3,}$
    public let startMs: Int
    public let endMs: Int
    public let durationMs: Int
    public let context: String     // after_question | mid_utterance | thinking | interruption
    public let annotation: String?
}

public struct Cue: Codable, Identifiable, Hashable, Sendable {
    public let id: String          // ^CUE-[0-9]{3,}$
    public let kind: String        // laughter | sigh | cough | ... | overlap | interruption
    public let startMs: Int
    public let endMs: Int
    public let speakerId: String?
    public let confidence: Double?
    public let annotation: String?
}

public struct Frame: Codable, Identifiable, Hashable, Sendable {
    public let id: String          // ^FR-[0-9]{3,}$
    public let atMs: Int
    public let path: String
    public let trigger: String
    public let linkedUtteranceId: String?
    public let annotation: String?
}
