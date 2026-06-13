import SwiftUI
import CompostKit

// One utterance, rendered natively: speaker lane color, timecode, prosody, and
// — the actual webview-vs-native differentiator — typed silences and audio cues
// shown inline as chips. Text is .textSelection(.enabled) so the native
// selection affordance is right there.
struct UtteranceRow: View {
    let utterance: Utterance
    let speaker: Speaker?
    let silences: [Silence]
    let cues: [Cue]

    private var speakerColor: Color { Theme.color(forSpeaker: utterance.speakerId) }

    private var speakerLabel: String {
        if let s = speaker {
            return s.name ?? "\(s.id) · \(s.type)"
        }
        return utterance.speakerId
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Rectangle()
                .fill(speakerColor)
                .frame(width: 3)
                .clipShape(Capsule())

            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(speakerLabel)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(speakerColor)
                    Text(Theme.timecode(utterance.startMs))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                    if let p = utterance.prosody {
                        if let pace = p.pace, pace != "normal" { Chip(text: pace, tint: .secondary) }
                        if let vol = p.volume, vol != "normal" { Chip(text: vol, tint: .secondary) }
                        if let h = p.hesitations, h > 0 { Chip(text: "\(h) hes", tint: .secondary) }
                    }
                    if let d = utterance.diarization?.confidence, d == 0 {
                        Chip(text: "low-conf spk", tint: .red)
                    }
                }

                Text(utterance.text)
                    .font(.body)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)

                if let note = utterance.annotation, !note.isEmpty {
                    Text(note).font(.callout.italic()).foregroundStyle(.secondary)
                }

                if !silences.isEmpty || !cues.isEmpty {
                    FlowChips {
                        ForEach(silences) { s in
                            Chip(text: "⏸ \(s.context.replacingOccurrences(of: "_", with: " ")) · \(Theme.seconds(s.durationMs))", tint: .blue)
                        }
                        ForEach(cues) { c in
                            Chip(text: "♪ \(c.kind)", tint: .purple)
                        }
                    }
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)))
        .contentShape(Rectangle())
    }
}

/// Minimal wrapping HStack for the chip row (avoids overflow on narrow widths).
struct FlowChips<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        HStack(spacing: 6) { content }
            .fixedSize(horizontal: false, vertical: true)
    }
}
