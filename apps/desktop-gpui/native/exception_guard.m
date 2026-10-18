#import <Foundation/Foundation.h>
#include <stdatomic.h>

// Calls `imp` and catches an Objective-C exception it throws. No Rust frame
// sits between the throw and this catch, so the exception never unwinds
// through Rust. Returns the exception retained (caller releases), or nil.
id cap_call_void_imp_catching(void (*imp)(id, SEL), id receiver, SEL selector) {
    @try {
        imp(receiver, selector);
        return nil;
    } @catch (id exception) {
        return [exception retain];
    }
}

_Atomic unsigned long cap_test_unbalanced_removal_calls = 0;

// Test fixture: the crash report's exception, removing a key-value observer
// that was never added.
void cap_test_unbalanced_kvo_removal(id receiver, SEL selector) {
    (void)receiver;
    (void)selector;
    atomic_fetch_add(&cap_test_unbalanced_removal_calls, 1);
    NSObject *observed = [[NSObject new] autorelease];
    NSObject *observer = [[NSObject new] autorelease];
    [observed removeObserver:observer forKeyPath:@"touchBar"];
}
