// Development reference capture only. Calls the installed Apple extension's
// snapshot API; it does not recreate or replace its rendering implementation.
import Foundation
import AppKit
import ExtensionFoundation
import ExtensionKit
import ObjectiveC
import Darwin

// Both installed SDKs expose this secure-coding class under the same Objective-C
// name. Decode through the installed class instead of reproducing its ABI.
final class InterfaceStateArchive: NSObject, NSSecureCoding {
    static var supportsSecureCoding: Bool { true }
    let watch: Bool
    init(watch: Bool) { self.watch = watch; super.init() }
    required init?(coder: NSCoder) { return nil }
    func encode(with coder: NSCoder) {
        for key in ["isRevoked", "isVoided", "isSimulatingDeviceMotion", "drawPassShadow", "showDebugFrameOutlines", "isRelevancyActive"] {
            coder.encode(false, forKey: key)
        }
        coder.encode(watch ? 1 : 0, forKey: "previewTarget")
        coder.encode("circular" as NSString, forKey: "simulatedDeviceMotionPath")
    }
}

@MainActor final class ReferenceCapture: NSObject, EXHostViewControllerDelegate {
    var host: EXHostViewController?
    var window: NSWindow?
    var connection: NSXPCConnection?
    var proxy: NSObject?
    var reference: URL?
    var passURL: URL?
    var requested = false
    var finished = false
    var signals: [DispatchSourceSignal] = []

    func finish(_ status: Int32) -> Never {
        finished = true
        if let reference { try? FileManager.default.removeItem(at: reference) }
        exit(status)
    }

    func start() async {
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { self.finish(128 + number) }
            source.resume()
            signals.append(source)
        }
        do {
            let fm = FileManager.default
            let app = ProcessInfo.processInfo.environment["AWP_PASS_DESIGNER_APP"] ?? "/Applications/Pass Designer.app"
            let framework = app + "/Contents/Frameworks/PassRenderSDK.framework/PassRenderSDK"
            guard dlopen(framework, RTLD_NOW | RTLD_GLOBAL) != nil else { finish(69) }
            let source = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true).resolvingSymlinksInPath()
            // The signed extension can read its existing app group. A bookmark
            // made by an unrelated host does not grant it access to other paths.
            // Only this unique, disposable copy is written or removed.
            let group = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Group Containers/group.com.apple.passdesigner", isDirectory: true).resolvingSymlinksInPath()
            guard fm.fileExists(atPath: group.path) else { finish(69) }
            if CommandLine.arguments.count == 5 {
                // The server owns this bounded input directory and removes it
                // after child exit, including SIGKILL / cancelled requests.
                guard CommandLine.arguments[4] == "--prepared",
                      source.path.hasPrefix(group.path + "/awp-preview-"),
                      source.lastPathComponent == "preview.pkpasstemplate" else { finish(65) }
                passURL = source
            } else {
            let copy = group.appendingPathComponent("awp-reference-" + UUID().uuidString + ".pkpasstemplate", isDirectory: true)
            try fm.createDirectory(at: copy, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            reference = copy
            guard let entries = fm.enumerator(at: source, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles]) else { finish(66) }
            var total = 0
            var count = 0
            for case let file as URL in entries {
                let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                guard values.isRegularFile == true, values.isSymbolicLink != true else { continue }
                let relative = String(file.path.dropFirst(source.path.count + 1))
                let parts = relative.split(separator: "/")
                let rootResource = parts.count == 1 && (relative == "pass.json" || relative.hasSuffix(".png"))
                let localized = parts.count == 2 && parts[0].hasSuffix(".lproj") && (parts[1] == "pass.strings" || parts[1].hasSuffix(".png"))
                guard rootResource || localized else { continue }
                let bytes = try Data(contentsOf: file)
                total += bytes.count
                count += 1
                guard total <= 16 * 1024 * 1024, count <= 300,
                      bytes.count <= (relative == "pass.json" ? 256 * 1024 : relative.hasSuffix(".png") ? 8 * 1024 * 1024 : 64 * 1024) else { finish(65) }
                let target = copy.appendingPathComponent(relative)
                try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                try bytes.write(to: target, options: .atomic)
            }
            guard fm.fileExists(atPath: copy.appendingPathComponent("pass.json").path) else { finish(66) }
            passURL = copy
            }
            for try await identities in try AppExtensionIdentity.matching(appExtensionPointIDs: "com.apple.passdesigner.passrender.extensionpoint.version28") {
                guard let identity = identities.first(where: { $0.bundleIdentifier == "com.apple.passdesigner.passrenderextension" }) else { finish(69) }
                let controller = EXHostViewController()
                host = controller
                controller.delegate = self
                let frame = NSRect(x: 0, y: 0, width: 343, height: 505)
                let hidden = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
                window = hidden
                hidden.contentViewController = controller
                controller.view.frame = frame
                controller.configuration = .init(appExtension: identity, sceneID: "pass-render-scene")
                controller.viewWillAppear()
                controller.viewDidAppear()
                return
            }
        } catch { finish(70) }
    }

    func hostViewControllerDidActivate(_ controller: EXHostViewController) {
        do {
            guard let proto = objc_getProtocol("_TtP13PassRenderSDK21PassRenderXPCProtocol_"),
                  let stateClass = NSClassFromString("PassRenderInterfaceState"), let passURL else { finish(69) }
            let transport = try controller.makeXPCConnection()
            connection = transport
            transport.remoteObjectInterface = NSXPCInterface(with: proto)
            transport.exportedInterface = NSXPCInterface(with: proto)
            transport.exportedObject = self
            transport.interruptionHandler = { Task { @MainActor in if !self.finished { self.finish(70) } } }
            transport.resume()
            let remote = transport.remoteObjectProxyWithErrorHandler { _ in Task { @MainActor in self.finish(70) } } as! NSObject
            proxy = remote
            let archive = try NSKeyedArchiver.archivedData(withRootObject: InterfaceStateArchive(watch: CommandLine.arguments[3] == "watch"), requiringSecureCoding: true)
            let decoder = try NSKeyedUnarchiver(forReadingFrom: archive)
            decoder.setClass(stateClass, forClassName: NSStringFromClass(InterfaceStateArchive.self))
            guard let state = decoder.decodeObject(of: [stateClass, NSString.self], forKey: NSKeyedArchiveRootObjectKey) else { finish(70) }
            remote.perform(NSSelectorFromString("updateInterfaceStateTo:"), with: state)
            let bookmark = try passURL.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)
            remote.perform(NSSelectorFromString("configureRenderWith:"), with: bookmark as NSData)
        } catch { finish(70) }
    }

    func hostViewControllerWillDeactivate(_ controller: EXHostViewController, error: (any Error)?) {
        if !finished { finish(70) }
    }

    @objc(renderContentSizeDidChangeTo:) func renderContentSizeDidChangeTo(_ size: CGSize) {
        guard size.width > 0, size.height > 0, !requested else { return }
        requested = true
        // Allow the extension's artwork and layout updates to settle. Its
        // snapshot method itself requests afterScreenUpdates: YES.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.snapshot() }
    }

    @objc(cursorHoverDidChangeTo:) func cursorHoverDidChangeTo(_ point: CGPoint) {}
    @objc func cursorHoverDidEnd() {}

    func snapshot() {
        guard let proxy else { finish(70) }
        let reply: @convention(block) (NSData?) -> Void = { data in
            Task { @MainActor in
                guard let data, data.length > 0 else { self.finish(65) }
                do {
                    try (data as Data).write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .atomic)
                    self.finish(0)
                } catch { self.finish(74) }
            }
        }
        proxy.perform(NSSelectorFromString("snapshotPassFaceWithReply:"), with: reply)
    }
}

@main struct CaptureMain {
    @MainActor static func main() {
        guard CommandLine.arguments.count == 4 || CommandLine.arguments.count == 5 else { exit(64) }
        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)
        application.finishLaunching()
        let capture = ReferenceCapture()
        Task { await capture.start() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 40) { capture.finish(75) }
        application.run()
    }
}
