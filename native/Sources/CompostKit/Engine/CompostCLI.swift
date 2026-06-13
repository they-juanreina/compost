import Foundation

// Subprocess wrapper around the `compost` CLI — the WRITE path (ADR 0003 §4:
// "dispatch mutations through the engine or CLI"). Mirrors the proven resolver
// in plugin/mcp/tools.ts (resolveCompostInvocation):
//   1. COMPOST_CLI env var — if it ends in .js, run it with node; else exec it.
//      (The runnable .js entry is cli/bin/compost.js, which calls run();
//      dist/index.js only *exports* run and emits nothing if run directly.)
//   2. otherwise `compost` on PATH.
// We launch via /usr/bin/env with an augmented PATH so node/compost resolve even
// when the app is launched from Finder (minimal PATH) — the spike's #1 risk.

public struct CompostCLI: Sendable {
    public let workingDirectory: URL
    public let environment: [String: String]
    public let cliOverride: String?

    public init(workingDirectory: URL,
                environment: [String: String]? = nil,
                cliOverride: String? = nil) {
        let base = environment ?? ProcessInfo.processInfo.environment
        self.workingDirectory = workingDirectory
        self.environment = CompostCLI.augmentPath(base)
        self.cliOverride = cliOverride ?? base["COMPOST_CLI"]
    }

    public struct Result: Sendable {
        public let stdout: String
        public let stderr: String
        public let code: Int32
    }

    /// CLI error envelope: `{ "error": { "code", "message" } }` on stderr, exit 1.
    public struct CLIError: Error, CustomStringConvertible {
        public let code: String
        public let message: String
        public var description: String { "\(code): \(message)" }
    }

    public struct SpawnFailure: Error, CustomStringConvertible {
        public let message: String
        public var description: String { message }
    }

    // MARK: - low-level spawn

    private func launchToken() -> (token: String, prefix: [String]) {
        if let o = cliOverride, !o.trimmingCharacters(in: .whitespaces).isEmpty {
            return o.hasSuffix(".js") ? ("node", [o]) : (o, [])
        }
        return ("compost", [])
    }

    /// Run `compost <argv...>` and capture stdout/stderr/exit. Pipes are drained
    /// on background threads BEFORE waitUntilExit — a `session` read is ~1 MB and
    /// would deadlock a full pipe otherwise.
    public func run(_ argv: [String]) throws -> Result {
        let (token, prefix) = launchToken()
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        proc.arguments = [token] + prefix + argv
        proc.currentDirectoryURL = workingDirectory
        proc.environment = environment

        let outPipe = Pipe(), errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe

        var outData = Data(), errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async {
            outData = outPipe.fileHandleForReading.readDataToEndOfFile(); group.leave()
        }
        group.enter()
        DispatchQueue.global().async {
            errData = errPipe.fileHandleForReading.readDataToEndOfFile(); group.leave()
        }

        do {
            try proc.run()
        } catch {
            throw SpawnFailure(message:
                "Could not spawn '\(token)'. Set COMPOST_CLI to an absolute cli/bin/compost.js, " +
                "or install the CLI (npm i -g @they-juanreina/compost-cli). Underlying: \(error)")
        }
        proc.waitUntilExit()
        group.wait()

        return Result(
            stdout: String(data: outData, encoding: .utf8) ?? "",
            stderr: String(data: errData, encoding: .utf8) ?? "",
            code: proc.terminationStatus
        )
    }

    // MARK: - typed commands

    private static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    /// If the CLI emitted an `{ error: {...} }` envelope, surface it as CLIError.
    private func throwIfError(_ result: Result) throws {
        let blob = result.stdout.isEmpty ? result.stderr : result.stdout
        guard let data = blob.data(using: .utf8) else { return }
        struct Envelope: Decodable { let error: Inner?; struct Inner: Decodable { let code: String; let message: String } }
        if let env = try? CompostCLI.decoder().decode(Envelope.self, from: data), let e = env.error {
            throw CLIError(code: e.code, message: e.message)
        }
        if result.code != 0 {
            throw CLIError(code: "EXIT_\(result.code)", message: blob.isEmpty ? "non-zero exit" : blob)
        }
    }

    /// P0 spawn proof: `compost status --seed <seed> --json` → raw JSON object.
    @discardableResult
    public func status(seed: String) throws -> JSONValue {
        let r = try run(["status", "--seed", seed, "--json"])
        try throwIfError(r)
        return JSONValue.parse(r.stdout)
    }

    public struct CreatedArtifact: Decodable, Sendable {
        public let id: String          // human ref, e.g. H-001
        public let artifactId: String  // sha256
        public let path: String
        public let eventId: String
    }

    /// Create a researcher-authored highlight. No `--ai` ⇒ actor_type=researcher,
    /// human_approved=true (create.ts:resolveAuthor). Atomic md + event write.
    public func createHighlight(seed: String, session: String, utterance: String,
                                span: (Int, Int), text: String) throws -> CreatedArtifact {
        let r = try run([
            "create", "highlight",
            "--seed", seed,
            "--session", session,
            "--utterance", utterance,
            "--span", "\(span.0),\(span.1)",
            "--text", text,
            "--json",
        ])
        try throwIfError(r)
        guard let data = r.stdout.data(using: .utf8) else {
            throw CLIError(code: "BAD_OUTPUT", message: "empty stdout from create highlight")
        }
        return try CompostCLI.decoder().decode(CreatedArtifact.self, from: data)
    }

    /// `compost blame <ref> --seed <seed> --json` — used by the reducer golden test.
    public func blame(_ ref: String, seed: String) throws -> JSONValue {
        let r = try run(["blame", ref, "--seed", seed, "--json"])
        try throwIfError(r)
        return JSONValue.parse(r.stdout)
    }

    // MARK: - PATH

    private static func augmentPath(_ env: [String: String]) -> [String: String] {
        var e = env
        let extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        let current = (e["PATH"] ?? "").split(separator: ":").map(String.init)
        var seen = Set<String>(), merged: [String] = []
        for p in extra + current where !seen.contains(p) { seen.insert(p); merged.append(p) }
        e["PATH"] = merged.joined(separator: ":")
        return e
    }
}
