import SwiftUI

@main
struct CompostSpikeApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup("Compost — \(model.seed)/\(model.sessionId)") {
            SessionReaderView(model: model)
                .frame(minWidth: 900, minHeight: 600)
                .task { await model.load() }
        }
    }
}
