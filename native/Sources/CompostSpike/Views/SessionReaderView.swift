import SwiftUI
import CompostKit

struct SessionReaderView: View {
    let model: AppModel
    @State private var composing: Utterance?

    var body: some View {
        HSplitView {
            transcriptPane
                .frame(minWidth: 540)
            HighlightsPanel(model: model)
                .frame(minWidth: 280, idealWidth: 340, maxWidth: 460)
        }
        .sheet(item: $composing) { u in
            HighlightComposer(utterance: u) { span, text in
                await model.createHighlight(utterance: u, span: span, text: text)
            }
        }
    }

    private var transcriptPane: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if let t = model.transcript {
                        ForEach(t.utterances) { u in
                            UtteranceRow(
                                utterance: u,
                                speaker: model.speakersById[u.speakerId],
                                silences: model.silences(in: u),
                                cues: model.cues(in: u)
                            )
                            .onTapGesture { composing = u }
                        }
                    } else {
                        ProgressView().frame(maxWidth: .infinity, minHeight: 200)
                    }
                }
                .padding(14)
            }
            Divider()
            statusBar
        }
    }

    private var statusBar: some View {
        HStack(spacing: 8) {
            if model.busy { ProgressView().controlSize(.small) }
            if let err = model.errorText {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text(err).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            } else {
                Text(model.statusLine).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text("click an utterance to highlight").font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }
}

/// Compose a highlight from a chosen quote inside an utterance. The span is the
/// quote's UTF-16 range within the utterance text (matching the engine's char
/// offsets); if the edited quote isn't a literal substring we fall back to a
/// 0-based span so the create never blocks (the engine doesn't validate it).
struct HighlightComposer: View {
    let utterance: Utterance
    let onCreate: (_ span: (Int, Int), _ text: String) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var quote: String = ""
    @State private var working = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("New highlight · \(utterance.id)").font(.headline)

            Text(utterance.text)
                .font(.callout)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, maxHeight: 150, alignment: .topLeading)
                .fixedSize(horizontal: false, vertical: true)

            Text("Quote").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $quote)
                .font(.body)
                .frame(height: 76)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(working ? "Creating…" : "Create Highlight") {
                    Task {
                        working = true
                        await onCreate(span(of: quote, in: utterance.text), quote)
                        working = false
                        dismiss()
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || working)
            }
        }
        .padding(20)
        .frame(width: 480)
        .onAppear { quote = String(utterance.text.prefix(min(60, utterance.text.count))) }
    }

    private func span(of quote: String, in text: String) -> (Int, Int) {
        let ns = text as NSString
        let r = ns.range(of: quote)
        if r.location != NSNotFound { return (r.location, r.location + r.length) }
        return (0, (quote as NSString).length)
    }
}
