import SwiftUI

enum Theme {
    /// Stable color per speaker id (so S1/S2/S3 read as distinct lanes).
    static let palette: [Color] = [.blue, .green, .orange, .purple, .pink, .teal, .indigo, .brown]

    static func color(forSpeaker id: String) -> Color {
        var hash = 5381
        for b in id.utf8 { hash = (hash &* 33) ^ Int(b) }
        return palette[abs(hash) % palette.count]
    }

    /// h:mm:ss timecode from milliseconds.
    static func timecode(_ ms: Int) -> String {
        let s = ms / 1000
        return String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60)
    }

    static func seconds(_ ms: Int) -> String {
        ms >= 1000 ? String(format: "%.1fs", Double(ms) / 1000) : "\(ms)ms"
    }
}

/// A small rounded label used for prosody / silence / cue chips.
struct Chip: View {
    let text: String
    let tint: Color
    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tint.opacity(0.15), in: Capsule())
            .foregroundStyle(tint)
    }
}
