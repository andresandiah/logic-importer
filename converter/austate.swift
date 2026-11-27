// austate: compare an Audio Unit's saved state with a freshly loaded copy of the plug-in.
// usage: austate <type> <subtype> <manufacturer> <state.plist> <out.json>
// "default" is what a new instance reports before any state is loaded.
import AudioToolbox
import Foundation

let args = CommandLine.arguments
guard args.count == 6 else {
    FileHandle.standardError.write("usage: austate <type> <subtype> <manu> <state.plist> <out.json>\n".data(using: .utf8)!)
    exit(2)
}

func finish(_ result: [String: Any]) -> Never {
    // Written to a file: plug-ins often print their own messages on stdout.
    let data = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    try! data.write(to: URL(fileURLWithPath: args[5]))
    exit(0)
}

func fourCC(_ s: String) -> OSType {
    var v: OSType = 0
    for b in s.data(using: .isoLatin1) ?? Data() { v = (v << 8) | OSType(b) }
    return v
}

var desc = AudioComponentDescription(componentType: fourCC(args[1]), componentSubType: fourCC(args[2]),
                                     componentManufacturer: fourCC(args[3]), componentFlags: 0, componentFlagsMask: 0)
guard let component = AudioComponentFindNext(nil, &desc) else {
    finish(["installed": false, "error": "This Audio Unit is not installed on this Mac."])
}
var cfName: Unmanaged<CFString>?
AudioComponentCopyName(component, &cfName)
let componentName = (cfName?.takeRetainedValue() as String?) ?? ""

var instance: AudioUnit?
var done = false
var instantiateStatus: OSStatus = noErr
AudioComponentInstantiate(component, []) { unit, status in
    DispatchQueue.main.async { instance = unit; instantiateStatus = status; done = true }
}
let deadline = Date().addingTimeInterval(45)
while !done && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
guard let unit = instance else {
    finish(["installed": true, "name": componentName, "error": "The plug-in did not load (status \(instantiateStatus))."])
}
// Some plug-ins only publish parameters once initialised; a failure here is not fatal.
_ = AudioUnitInitialize(unit)

func parameterIDs() -> [AudioUnitParameterID] {
    var size: UInt32 = 0
    guard AudioUnitGetPropertyInfo(unit, kAudioUnitProperty_ParameterList, kAudioUnitScope_Global, 0, &size, nil) == noErr,
          size > 0 else { return [] }
    var ids = [AudioUnitParameterID](repeating: 0, count: Int(size) / MemoryLayout<AudioUnitParameterID>.size)
    guard AudioUnitGetProperty(unit, kAudioUnitProperty_ParameterList, kAudioUnitScope_Global, 0, &ids, &size) == noErr else { return [] }
    return ids
}

struct Info { var name: String; var min: Float; var max: Float; var writable: Bool; var unit: String; var hasStrings: Bool }

let unitNames: [AudioUnitParameterUnit: String] = [
    .boolean: "on/off", .percent: "%", .seconds: "s", .hertz: "Hz", .decibels: "dB", .milliseconds: "ms",
    .cents: "cents", .relativeSemiTones: "semitones", .BPM: "BPM", .beats: "beats", .degrees: "degrees", .ratio: "ratio",
]

func info(_ id: AudioUnitParameterID) -> Info? {
    var raw = AudioUnitParameterInfo()
    var size = UInt32(MemoryLayout<AudioUnitParameterInfo>.size)
    guard AudioUnitGetProperty(unit, kAudioUnitProperty_ParameterInfo, kAudioUnitScope_Global, id, &raw, &size) == noErr else { return nil }
    var name = ""
    if raw.flags.contains(.flag_HasCFNameString), let s = raw.cfNameString {
        name = s.takeUnretainedValue() as String
        if raw.flags.contains(.flag_CFNameRelease) { s.release() }
    } else {
        name = withUnsafeBytes(of: raw.name) { String(decoding: $0.prefix(while: { $0 != 0 }), as: UTF8.self) }
    }
    return Info(name: name, min: raw.minValue, max: raw.maxValue, writable: raw.flags.contains(.flag_IsWritable),
                unit: unitNames[raw.unit] ?? "",
                hasStrings: raw.flags.contains(.flag_ValuesHaveStrings) || raw.unit == .indexed)
}

func value(_ id: AudioUnitParameterID) -> Float? {
    var v: AudioUnitParameterValue = 0
    guard AudioUnitGetParameter(unit, id, kAudioUnitScope_Global, 0, &v) == noErr, v.isFinite else { return nil }
    return v
}

func text(_ id: AudioUnitParameterID, _ v: Float) -> String? {
    var v = v
    return withUnsafePointer(to: &v) { pointer -> String? in
        var request = AudioUnitParameterStringFromValue(inParamID: id, inValue: pointer, outString: nil)
        var size = UInt32(MemoryLayout<AudioUnitParameterStringFromValue>.size)
        guard AudioUnitGetProperty(unit, kAudioUnitProperty_ParameterStringFromValue, kAudioUnitScope_Global, 0, &request, &size) == noErr,
              let s = request.outString else { return nil }
        return s.takeRetainedValue() as String
    }
}

var defaults: [AudioUnitParameterID: (Float, String?)] = [:]
for id in parameterIDs() {
    if let v = value(id) { defaults[id] = (v, text(id, v)) }
}

guard let stateData = FileManager.default.contents(atPath: args[4]),
      var state = (try? PropertyListSerialization.propertyList(from: stateData, format: nil)) as CFPropertyList? else {
    finish(["installed": true, "name": componentName, "error": "The saved state could not be read."])
}
let loadStatus = withUnsafePointer(to: &state) {
    AudioUnitSetProperty(unit, kAudioUnitProperty_ClassInfo, kAudioUnitScope_Global, 0, $0, UInt32(MemoryLayout<CFPropertyList>.size))
}
if loadStatus != noErr {
    finish(["installed": true, "name": componentName, "error": "The plug-in rejected the saved state (status \(loadStatus))."])
}
RunLoop.main.run(until: Date().addingTimeInterval(0.5))

var rows: [[String: Any]] = []
for id in parameterIDs() {
    guard let i = info(id), i.writable, let saved = value(id) else { continue }
    var row: [String: Any] = ["id": Int(id), "name": i.name, "unit": i.unit, "saved": Double(saved)]
    if i.min.isFinite && i.max.isFinite { row["min"] = Double(i.min); row["max"] = Double(i.max) }
    if let s = text(id, saved) { row["savedText"] = s }
    if let (d, s) = defaults[id] {
        row["default"] = Double(d)
        if let s = s { row["defaultText"] = s }
        let span = abs(i.max - i.min)
        let tolerance = span.isFinite && span > 0 ? span * 1e-5 : 1e-6
        row["modified"] = abs(saved - d) > tolerance
    }
    rows.append(row)
}
finish(["installed": true, "name": componentName, "params": rows])
