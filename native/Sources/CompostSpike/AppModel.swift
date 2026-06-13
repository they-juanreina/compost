import Foundation
import Observation
import CompostKit

// The rendering shell's state. Reads go straight to the canonical files
// (transcript.json) and the ledger (events.sqlite, reduced in Swift); the one
// write — createHighlight — is delegated to the CLI. Nothing here reimplements
// engine logic (ADR 0003 §4).
@MainActor
@Observable
final class AppModel {
    // Config (overridable via env so you can point at any seed/session).
    let workspace: URL
    let seed: String
    let sessionId: String

    // Data
    var transcript: Transcript?
    var highlights: [Snapshot] = []
    var speakersById: [String: Speaker] = [:]
    var statusLine: String = "Loading…"
    var errorText: String?
    var busy = false

    private let cli: CompostCLI

    init() {
        let env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser
        let ws = env["COMPOST_WORKSPACE"].map { URL(fileURLWithPath: $0) }
            ?? home.appendingPathComponent("compost-readiness")
        self.workspace = ws
        self.seed = env["COMPOST_SEED"] ?? "audio-probe"
        self.sessionId = env["COMPOST_SESSION"] ?? "S001"
        self.cli = CompostCLI(workingDirectory: ws)
    }

    private var seedDir: URL { workspace.appendingPathComponent("Seeds/\(seed)") }
    private var transcriptURL: URL { seedDir.appendingPathComponent("sessions/\(sessionId)/transcript.json") }
    private var eventsURL: URL { seedDir.appendingPathComponent(".compost/events.sqlite") }

    func load() async {
        do {
            let t = try Transcript.load(contentsOf: transcriptURL)
            transcript = t
            speakersById = Dictionary(t.speakers.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            statusLine = "\(t.utterances.count) utterances · \(t.speakers.count) speakers · "
                + "\(t.silences?.count ?? 0) silences · \(t.cues?.count ?? 0) cues · \(t.durationMs / 1000)s"
            errorText = nil
            await refreshHighlights()
        } catch {
            errorText = "Failed to load \(transcriptURL.lastPathComponent): \(error)"
        }
    }

    func refreshHighlights() async {
        let url = eventsURL
        do {
            highlights = try await Task.detached { try EventLog(path: url).snapshots(kind: "highlight") }.value
        } catch {
            errorText = "Failed to read ledger: \(error)"
        }
    }

    func createHighlight(utterance: Utterance, span: (Int, Int), text: String) async {
        guard !text.isEmpty else { return }
        busy = true
        defer { busy = false }
        let cli = self.cli, seed = self.seed, sessionId = self.sessionId
        let uid = utterance.id
        do {
            _ = try await Task.detached {
                try cli.createHighlight(seed: seed, session: sessionId, utterance: uid, span: span, text: text)
            }.value
            await refreshHighlights()
            errorText = nil
        } catch {
            errorText = "Create failed: \(error)"
        }
    }

    func silences(in u: Utterance) -> [Silence] {
        (transcript?.silences ?? []).filter { $0.startMs < u.endMs && $0.endMs > u.startMs }
    }
    func cues(in u: Utterance) -> [Cue] {
        (transcript?.cues ?? []).filter { $0.startMs < u.endMs && $0.endMs > u.startMs }
    }
}
