import Foundation
import CompostKit

// Headless verification of the engine boundary — the parts a GUI can't show in
// this environment. Read-only by default; pass --create to exercise the write
// round-trip (P3), which appends one researcher highlight to the seed.
//
//   swift run Probe                # P0 spawn, P1 transcript, P2 ledger reduce
//   swift run Probe --create       # + P3 create-highlight round-trip
//
// Workspace defaults to ~/compost-readiness; override with COMPOST_WORKSPACE.
// Set COMPOST_CLI to an absolute cli/bin/compost.js to pin the repo build
// (dist/index.js only exports run() — it emits nothing if run directly).

let args = CommandLine.arguments
let doCreate = args.contains("--create")

let env = ProcessInfo.processInfo.environment
let home = FileManager.default.homeDirectoryForCurrentUser
let workspace = env["COMPOST_WORKSPACE"].map { URL(fileURLWithPath: $0) }
    ?? home.appendingPathComponent("compost-readiness")
let seed = env["COMPOST_SEED"] ?? "audio-probe"
let sessionId = env["COMPOST_SESSION"] ?? "S001"

let seedDir = workspace.appendingPathComponent("Seeds/\(seed)")
let transcriptURL = seedDir.appendingPathComponent("sessions/\(sessionId)/transcript.json")
let eventsURL = seedDir.appendingPathComponent(".compost/events.sqlite")

func section(_ s: String) { print("\n=== \(s) ===") }
func fail(_ s: String) -> Never { FileHandle.standardError.write(Data("✗ \(s)\n".utf8)); exit(1) }

print("workspace: \(workspace.path)")
print("seed:      \(seed)  session: \(sessionId)")
print("CLI:       \(env["COMPOST_CLI"] ?? "compost (PATH)")")

let cli = CompostCLI(workingDirectory: workspace)

// ── P0 — prove a GUI-spawnable CLI returns parseable JSON ───────────────────
section("P0 — spawn the CLI (compost status --json)")
do {
    let status = try cli.status(seed: seed)
    if let obj = status.asObject {
        print("✓ status JSON keys: \(obj.keys.sorted().joined(separator: ", "))")
    } else {
        print("✓ status returned JSON (non-object)")
    }
} catch {
    fail("status spawn failed: \(error)")
}

// ── P1 — decode the canonical transcript directly ───────────────────────────
section("P1 — load transcript.json (Codable, no CLI hop)")
let transcript: Transcript
do {
    transcript = try Transcript.load(contentsOf: transcriptURL)
    print("✓ \(transcript.sessionId): \(transcript.utterances.count) utterances, "
        + "\(transcript.speakers.count) speakers, \(transcript.silences?.count ?? 0) silences, "
        + "\(transcript.cues?.count ?? 0) cues, \(Int(transcript.durationMs / 1000))s")
    if let first = transcript.utterances.first {
        print("   first: [\(first.speakerId)] \(first.text.prefix(70))")
    }
} catch {
    fail("transcript decode failed: \(error)")
}

// ── P2 — open events.sqlite read-only and reduce in Swift ───────────────────
section("P2 — reduce events.sqlite (read-only, WAL-safe)")
let log = EventLog(path: eventsURL)
func highlightSnapshots() throws -> [Snapshot] { try log.snapshots(kind: "highlight") }
do {
    let all = try log.allEvents()
    let kinds = Dictionary(grouping: all, by: { $0.artifactKind }).mapValues { $0.count }
    print("✓ \(all.count) total events  \(kinds.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))")
    let hs = try highlightSnapshots()
    print("✓ \(hs.count) highlight snapshot(s) after reduce")
    for h in hs.prefix(5) {
        let id = h.currentState["id"]?.asString ?? String(h.artifactId.prefix(8))
        let text = h.currentState["text"]?.asString ?? "(no text)"
        print("   • \(id) approved=\(h.humanApproved) v\(h.version) — \(text.prefix(56))")
    }
} catch {
    fail("event reduce failed: \(error)")
}

// ── P3 — write round-trip (opt-in) ──────────────────────────────────────────
if doCreate {
    section("P3 — create a researcher highlight via the CLI, verify round-trip")
    guard let u = transcript.utterances.first(where: { !$0.text.isEmpty }) else {
        fail("no utterance with text to highlight")
    }
    let quote = String(u.text.prefix(min(40, u.text.count)))
    let before = (try? highlightSnapshots().count) ?? 0
    do {
        let created = try cli.createHighlight(
            seed: seed, session: transcript.sessionId, utterance: u.id,
            span: (0, quote.utf16.count), text: quote)
        print("✓ created \(created.id)  artifact=\(created.artifactId.prefix(8))…  event=\(created.eventId)")

        // (1) markdown landed
        let mdURL = seedDir.appendingPathComponent("highlights/\(created.id).md")
        print(FileManager.default.fileExists(atPath: mdURL.path)
            ? "✓ markdown landed: highlights/\(created.id).md"
            : "✗ markdown missing at highlights/\(created.id).md")

        // (2) Swift-reduced ledger now includes it
        let after = try highlightSnapshots()
        let snap = after.first { $0.artifactId == created.artifactId }
        if let snap {
            print("✓ ledger reduce includes \(created.id): approved=\(snap.humanApproved) (expect true), v\(snap.version)")
        } else {
            print("✗ reduced ledger missing the new highlight (\(before) → \(after.count))")
        }

        // (3) reducer-fidelity cross-check against `compost blame`
        if let blame = try? cli.blame(created.id, seed: seed), let obj = blame.asObject {
            print("✓ blame \(created.id): keys \(obj.keys.sorted().joined(separator: ", "))")
        }
    } catch {
        fail("create highlight failed: \(error)")
    }
} else {
    print("\n(read-only run — pass --create to exercise the P3 write round-trip)")
}

print("\n✓ probe complete")
