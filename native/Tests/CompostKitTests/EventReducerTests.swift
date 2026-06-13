import XCTest
@testable import CompostKit

// Pins the Swift reducer to provenance/src/reducer.ts semantics. These are the
// exact cases reducer.ts encodes; if the port drifts, these fail (spike risk #3).
final class EventReducerTests: XCTestCase {

    private func ev(_ action: Action,
                    actor: String = "researcher",
                    kind: String = "highlight",
                    artifact: String = "a",
                    id: String,
                    payload: JSONValue) -> EventRow {
        EventRow(id: id, ts: id, artifactKind: kind, artifactId: artifact,
                 action: action, actorType: actor, actorId: "\(actor)-1", payload: payload)
    }

    func testResearcherCreateIsApproved() throws {
        let e = ev(.create, actor: "researcher", id: "01",
                   payload: .object(["id": .string("H-001"), "text": .string("hello")]))
        let snap = try XCTUnwrap(EventReducer.reduce([e]))
        XCTAssertTrue(snap.humanApproved)          // actor_type == researcher
        XCTAssertFalse(snap.archived)
        XCTAssertEqual(snap.version, 1)
        XCTAssertEqual(snap.currentState["text"]?.asString, "hello")
        XCTAssertEqual(snap.currentState["id"]?.asString, "H-001")
    }

    func testAICreateIsDraft() throws {
        let e = ev(.create, actor: "ai", id: "01", payload: .object(["text": .string("draft")]))
        let snap = try XCTUnwrap(EventReducer.reduce([e]))
        XCTAssertFalse(snap.humanApproved)         // AI ⇒ [draft] until endorsed
    }

    func testEndorseFlipsApprovedAndRecordsEndorsement() throws {
        let c = ev(.create, actor: "ai", id: "01", payload: .object(["text": .string("x")]))
        let e = ev(.endorse, actor: "researcher", id: "02", payload: .null)
        let snap = try XCTUnwrap(EventReducer.reduce([c, e]))
        XCTAssertTrue(snap.humanApproved)
        XCTAssertEqual(snap.version, 2)
        let endorsement = try XCTUnwrap(snap.currentState["_endorsement"]?.asObject)
        XCTAssertEqual(endorsement["endorsed_by"]?.asString, "researcher-1")
        XCTAssertEqual(endorsement["endorsed_at"]?.asString, "02")
    }

    func testUpdateFieldPatchSetsOneKey() throws {
        let c = ev(.create, id: "01", payload: .object(["text": .string("a"), "note": .string("n")]))
        let u = ev(.update, id: "02", payload: .object(["field": .string("text"), "after": .string("b")]))
        let snap = try XCTUnwrap(EventReducer.reduce([c, u]))
        XCTAssertEqual(snap.currentState["text"]?.asString, "b")
        XCTAssertEqual(snap.currentState["note"]?.asString, "n")  // untouched
    }

    func testUpdateFullObjectMerges() throws {
        let c = ev(.create, id: "01", payload: .object(["text": .string("a")]))
        let u = ev(.update, id: "02", payload: .object(["extra": .string("z")]))
        let snap = try XCTUnwrap(EventReducer.reduce([c, u]))
        XCTAssertEqual(snap.currentState["text"]?.asString, "a")
        XCTAssertEqual(snap.currentState["extra"]?.asString, "z")
    }

    func testRejectArchives() throws {
        let c = ev(.create, actor: "researcher", id: "01", payload: .object(["text": .string("a")]))
        let r = ev(.reject, actor: "researcher", id: "02", payload: .object(["note": .string("bad")]))
        let snap = try XCTUnwrap(EventReducer.reduce([c, r]))
        XCTAssertTrue(snap.archived)
        XCTAssertFalse(snap.humanApproved)
        XCTAssertNotNil(snap.currentState["_archive_reason"]?.asObject)
        XCTAssertEqual(snap.currentState["_archived_by"]?.asString, "researcher-1")
    }

    func testArtifactMismatchThrows() {
        let a = ev(.create, artifact: "a", id: "01", payload: .object([:]))
        let b = ev(.update, artifact: "b", id: "02", payload: .object([:]))
        XCTAssertThrowsError(try EventReducer.reduce([a, b]))
    }

    func testReduceAllGroupsByArtifact() throws {
        let a1 = ev(.create, artifact: "a", id: "01", payload: .object(["text": .string("a")]))
        let b1 = ev(.create, artifact: "b", id: "02", payload: .object(["text": .string("b")]))
        let a2 = ev(.update, artifact: "a", id: "03",
                    payload: .object(["field": .string("text"), "after": .string("a2")]))
        let snaps = try EventReducer.reduceAll([a1, b1, a2])
        XCTAssertEqual(snaps.count, 2)
        let aSnap = try XCTUnwrap(snaps.first { $0.artifactId == "a" })
        XCTAssertEqual(aSnap.version, 2)
        XCTAssertEqual(aSnap.currentState["text"]?.asString, "a2")
    }

    func testEmptyReduceIsNil() throws {
        XCTAssertNil(try EventReducer.reduce([]))
    }

    func testJSONValueParsesNestedPayload() {
        let v = JSONValue.parse(#"{"id":"H-001","span":[0,16],"ok":true,"x":null}"#)
        let obj = v.asObject
        XCTAssertEqual(obj?["id"]?.asString, "H-001")
        XCTAssertEqual(obj?["ok"], .bool(true))
        XCTAssertEqual(obj?["x"], .null)
        if case .array(let span)? = obj?["span"] {
            XCTAssertEqual(span, [.number(0), .number(16)])
        } else {
            XCTFail("span should be an array")
        }
    }
}
