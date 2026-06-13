import SwiftUI
import CompostKit

// The right rail: highlights as REDUCED from events.sqlite (not read from the
// .md files). The approved/draft badge comes straight from the reducer's
// human_approved (researcher create ⇒ approved; AI create ⇒ draft).
struct HighlightsPanel: View {
    let model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Highlights").font(.headline)
                Spacer()
                Text("\(model.highlights.count)")
                    .font(.callout).foregroundStyle(.secondary)
                Button {
                    Task { await model.refreshHighlights() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Re-read and reduce the event log")
            }
            .padding(12)
            Divider()

            if model.highlights.isEmpty {
                ContentUnavailableView(
                    "No highlights yet",
                    systemImage: "highlighter",
                    description: Text("Click an utterance to create one.")
                )
                .frame(maxHeight: .infinity)
            } else {
                List(model.highlights, id: \.artifactId) { h in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(h.currentState["id"]?.asString ?? String(h.artifactId.prefix(8)))
                                .font(.caption.weight(.semibold))
                            Spacer()
                            if h.humanApproved {
                                Label("approved", systemImage: "checkmark.seal.fill")
                                    .labelStyle(.iconOnly)
                                    .foregroundStyle(.green)
                                    .help("researcher-authored")
                            } else {
                                Text("draft")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.orange)
                                    .help("AI-authored, awaiting endorsement")
                            }
                        }
                        Text(h.currentState["text"]?.asString ?? "")
                            .font(.callout)
                            .lineLimit(3)
                            .foregroundStyle(.primary)
                    }
                    .padding(.vertical, 2)
                }
                .listStyle(.inset)
            }
        }
    }
}
