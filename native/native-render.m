// Local rendering worker for Pass Designer parity. This uses the same OS
// PKPassView / NPKPassView factories as Apple's Pass Designer render extension.
// Private APIs are confined to this macOS tool; no Apple binaries or fonts ship
// in the browser bundle. Input is a temporary, unsigned pass resource directory.
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <QuartzCore/QuartzCore.h>
#import <CoreGraphics/CoreGraphics.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <dlfcn.h>

static id Get(id object, const char *selector) {
    return ((id (*)(id, SEL))objc_msgSend)(object, sel_registerName(selector));
}

static void Set(id object, const char *selector, id value) {
    ((void (*)(id, SEL, id))objc_msgSend)(object, sel_registerName(selector), value);
}

static char WatchFieldKey;
static id (*OriginalWatchFieldValue)(id, SEL, id, BOOL);

static id WatchFieldValue(id view, SEL selector, id field, BOOL reversed) {
    // NPKCardPassFieldView copies text out of its field and does not retain a
    // field getter. Keep the original model for hit testing in this worker.
    objc_setAssociatedObject(view, &WatchFieldKey, field, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    return OriginalWatchFieldValue(view, selector, field, reversed);
}

static char WatchFieldsKey;
static void (*OriginalWatchStackFieldConfigure)(id, SEL, id, id);

static void WatchStackFieldConfigure(id stack, SEL selector, id view, id guide) {
    OriginalWatchStackFieldConfigure(stack, selector, view, guide);
    id fields = [guide respondsToSelector:sel_registerName("fields")] ? Get(guide, "fields") : nil;
    if ([fields isKindOfClass:NSArray.class]) {
        objc_setAssociatedObject(view, &WatchFieldsKey, fields, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
}

static void TrackWatchFields(void) {
    // Regular Watch rows copy raw strings from a layout guide. Keep its
    // ordered models; the final UIStackView order identifies each field.
    Method configure = class_getInstanceMethod(NSClassFromString(@"NPKCardPassRegularFieldStackView"),
        sel_registerName("_configurePassFieldView:withLayoutGuide:"));
    if (configure && method_getNumberOfArguments(configure) == 4) {
        OriginalWatchStackFieldConfigure = (void *)method_setImplementation(configure, (IMP)WatchStackFieldConfigure);
    }
    Class fieldView = NSClassFromString(@"NPKCardPassFieldView");
    Method value = class_getInstanceMethod(fieldView,
        sel_registerName("_valueForField:needsReversedOrder:"));
    if (value && method_getNumberOfArguments(value) == 4) {
        OriginalWatchFieldValue = (void *)method_setImplementation(value, (IMP)WatchFieldValue);
    }
}

static void InspectView(UIView *view, UIView *root, NSMutableArray *nodes) {
    CGRect frame = [view convertRect:view.bounds toView:root];
    frame = CGRectOffset(frame, -root.bounds.origin.x, -root.bounds.origin.y);
    NSMutableDictionary *node = [@{
        @"class": NSStringFromClass(view.class),
        @"x": @(frame.origin.x), @"y": @(frame.origin.y),
        @"width": @(frame.size.width), @"height": @(frame.size.height),
        @"hidden": @(view.hidden), @"alpha": @(view.alpha)
    } mutableCopy];
    id field = [view respondsToSelector:sel_registerName("field")] ? Get(view, "field") : objc_getAssociatedObject(view, &WatchFieldKey);
    if (!field && [view.superview isKindOfClass:UIStackView.class]) {
        NSArray *fields = objc_getAssociatedObject(view, &WatchFieldsKey);
        NSUInteger index = [((UIStackView *)view.superview).arrangedSubviews indexOfObjectIdenticalTo:view];
        if (index != NSNotFound && index < fields.count) field = fields[index];
    }
    if (field) {
        if ([field respondsToSelector:sel_registerName("key")]) {
            id key = Get(field, "key");
            if ([key isKindOfClass:NSString.class]) node[@"fieldKey"] = key;
        }
    }
    if ([view isKindOfClass:UILabel.class]) {
        UILabel *label = (UILabel *)view;
        node[@"text"] = label.text ?: @"";
        node[@"font"] = label.font.fontName;
        node[@"fontSize"] = @(label.font.pointSize);
        node[@"ascender"] = @(label.font.ascender);
        node[@"descender"] = @(label.font.descender);
        node[@"lineHeight"] = @(label.font.lineHeight);
        node[@"alignment"] = @(label.textAlignment);
        node[@"lines"] = @(label.numberOfLines);
        node[@"naturalWidth"] = @([label.attributedText size].width);
    }
    [nodes addObject:node];
    for (UIView *child in view.subviews) InspectView(child, root, nodes);
}

static UIWindowScene *renderScene;

static int RenderPass(int argc, char **argv) {
    // The parent may restart an aborted UIKit scene launch once. Emit this
    // before reading pass input so render/data failures are never retried.
    fputs("PASSMK_RENDER_STARTED\n", stdout);
    fflush(stdout);
    @autoreleasepool {
        if (argc < 3) { fprintf(stderr, "Usage: native-render PASS_DIRECTORY OUTPUT_DIRECTORY [WIDTH] [SCALE] [FACE]\n"); return 64; }
        @try {
            // A real Catalyst scene is required for hierarchy capture. A bare
            // command-line UIView cannot use drawViewHierarchy, and changing
            // image-layer backing scales distorts resizable artwork.
            dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", RTLD_NOW);
            id application = Get(NSClassFromString(@"NSApplication"), "sharedApplication");
            void *framework = dlopen("/System/iOSSupport/System/Library/PrivateFrameworks/PassKitUI.framework/PassKitUI", RTLD_NOW);
            if (!framework) { fprintf(stderr, "PassKitUI is unavailable.\n"); return 69; }
            NSString *input = @(argv[1]);
            NSString *output = @(argv[2]);
            CGFloat width = argc > 3 ? atof(argv[3]) : 343;
            CGFloat scale = argc > 4 ? atof(argv[4]) : 2;
            NSString *face = argc > 5 ? @(argv[5]) : @"front";
            NSData *jsonData = [NSData dataWithContentsOfFile:[input stringByAppendingPathComponent:@"pass.json"]];
            NSError *error = nil;
            NSDictionary *dictionary = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:&error];
            if (![dictionary isKindOfClass:NSDictionary.class]) { fprintf(stderr, "Invalid pass JSON.\n"); return 65; }

            id accessor = ((id (*)(id, SEL, id, NSError **))objc_msgSend)(
                [NSClassFromString(@"PKFileDataAccessor") alloc], sel_registerName("initWithFileURL:error:"),
                [NSURL fileURLWithPath:input], NULL);
            id bundle = Get(accessor, "bundle");
            id pass = ((id (*)(id, SEL, id, id))objc_msgSend)(
                [NSClassFromString(@"PKPass") alloc], sel_registerName("initWithDictionary:bundle:"), dictionary, bundle);
            if (!pass) { fprintf(stderr, "Could not load the pass template.\n"); return 65; }
            Set(pass, "setDataAccessor:", accessor);
            NSUInteger passType = ((NSUInteger (*)(id, SEL))objc_msgSend)(pass, sel_registerName("passType"));
            id content = ((id (*)(id, SEL, id, id, id, NSUInteger))objc_msgSend)(
                [NSClassFromString(@"PKPassContent") alloc], sel_registerName("initWithDictionary:bundle:privateBundle:passType:"),
                dictionary, bundle, nil, passType);
            Set(pass, "setContent:", content);

            UIView *view;
            if ([face isEqualToString:@"watch"]) {
                dlopen("/System/iOSSupport/System/Library/PrivateFrameworks/NanoPassKitUI.framework/NanoPassKitUI", RTLD_NOW);
                TrackWatchFields();
                view = ((id (*)(id, SEL, id, NSUInteger, CGFloat))objc_msgSend)(
                    NSClassFromString(@"NPKPassView"), sel_registerName("viewForPass:watchLayoutVariant:desiredWidth:"), pass, 3, width);
                if ([view respondsToSelector:sel_registerName("updateUIIfNeeded")]) Get(view, "updateUIIfNeeded");
            } else {
                // Match Pass Designer's render extension's content mode.
                view = ((id (*)(id, SEL, id, NSInteger))objc_msgSend)(
                    [NSClassFromString(@"PKPassView") alloc], sel_registerName("initWithPass:content:"), pass, 5);
                if ([view respondsToSelector:sel_registerName("_disablePortals")]) Get(view, "_disablePortals");
            }
            if (!view) { fprintf(stderr, "The pass style has no preview.\n"); return 65; }
            // NPK's factory already sets its scaled frame. sizeThatFits returns
            // the unscaled Watch layout height and must not replace that frame.
            CGSize size = [face isEqualToString:@"watch"] ? view.frame.size : [view sizeThatFits:CGSizeMake(width, 2000)];
            if (size.width <= 0 || size.height <= 0) size = view.bounds.size;
            if (size.width <= 0 || size.height <= 0 || size.width > 2048 || size.height > 4096) {
                fprintf(stderr, "Invalid native preview size.\n"); return 65;
            }
            UIWindow *window = [[UIWindow alloc] initWithWindowScene:renderScene];
            window.frame = CGRectMake(0, 0, size.width, size.height);
            UIViewController *controller = [UIViewController new];
            window.rootViewController = controller;
            controller.view.frame = window.bounds;
            [controller.view addSubview:view];
            view.frame = CGRectMake(0, 0, size.width, size.height);
            window.hidden = NO;
            // Keep this worker's windows outside the desktop. The UIKit scene
            // remains renderable; it never becomes the key window.
            for (id nativeWindow in Get(application, "windows")) {
                ((void (*)(id, SEL, CGPoint))objc_msgSend)(nativeWindow,
                    sel_registerName("setFrameOrigin:"), CGPointMake(-20000, -20000));
            }
            [view setNeedsLayout];
            [window layoutIfNeeded];
            [view layoutIfNeeded];
            // Native image sets and barcode generation complete on the main
            // run loop. This process handles one pass and exits after capture.
            for (int tick = 0; tick < 20; tick++) {
                [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
                [window layoutIfNeeded];
                [view layoutIfNeeded];
            }
            NSMutableArray *nodes = [NSMutableArray new];
            InspectView(view, view, nodes);
            [[NSFileManager defaultManager] createDirectoryAtPath:output withIntermediateDirectories:YES attributes:nil error:&error];
            NSData *layout = [NSJSONSerialization dataWithJSONObject:nodes options:NSJSONWritingPrettyPrinted error:&error];
            if (![layout writeToFile:[output stringByAppendingPathComponent:@"layout.json"] atomically:YES]) return 74;
            UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat new];
            format.scale = scale;
            format.opaque = NO;
            // Match the app's context size and translation before cropping its
            // margin in Node. The canvas origin affects color dithering.
            UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(size.width + 100, size.height + 100) format:format];
            __block BOOL captured = NO;
            UIImage *image = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
                CGContextTranslateCTM(context.CGContext, 50, 50);
                captured = [view drawViewHierarchyInRect:CGRectMake(0, 0, size.width, size.height) afterScreenUpdates:YES];
            }];
            if (!captured) { fprintf(stderr, "Native hierarchy capture is unavailable.\n"); return 69; }
            if (![UIImagePNGRepresentation(image) writeToFile:[output stringByAppendingPathComponent:@"native.png"] atomically:YES]) return 74;
        } @catch (NSException *exception) {
            // Keep private pass contents out of logs and HTTP error responses.
            fprintf(stderr, "Native pass rendering raised an exception.\n");
            return 70;
        }
    }
    return 0;
}

static int renderArgc;
static char **renderArgv;

@interface PassRenderSceneDelegate : UIResponder <UIWindowSceneDelegate>
@end
@implementation PassRenderSceneDelegate
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    renderScene = (UIWindowScene *)scene;
    dispatch_async(dispatch_get_main_queue(), ^{
        [renderScene.traitCollection performAsCurrentTraitCollection:^{
            exit(RenderPass(renderArgc, renderArgv));
        }];
    });
}
@end

@interface PassRenderAppDelegate : UIResponder <UIApplicationDelegate>
@end
@implementation PassRenderAppDelegate
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options { return YES; }
- (UISceneConfiguration *)application:(UIApplication *)application configurationForConnectingSceneSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    UISceneConfiguration *configuration = [[UISceneConfiguration alloc] initWithName:@"Render" sessionRole:session.role];
    configuration.delegateClass = PassRenderSceneDelegate.class;
    configuration.sceneClass = UIWindowScene.class;
    return configuration;
}
@end

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "Usage: native-render PASS_DIRECTORY OUTPUT_DIRECTORY [WIDTH] [SCALE] [FACE]\n"); return 64; }
    renderArgc = argc;
    renderArgv = argv;
    @autoreleasepool {
        return UIApplicationMain(argc, argv, nil, NSStringFromClass(PassRenderAppDelegate.class));
    }
}
