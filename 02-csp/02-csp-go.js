/**
 *
 * Now let's have a look at how simple channels can be used together with
 * generators to create async programming simpler and more intuitive.
 *
 */

// Some shorthands that we will be using.
import {
    chan,         // - Creates channels for communication.
    go,           // - Wrapper function for out generators.
    put,          // - Like putAsync in previous, only these
    take,         //   works with generators.
    timeout       // - Much like setTimeout(). See examples.
} from 'js-csp';

// First we create a new channel that we will used throughout this example.
var ch = chan();

// `csp.go` takes a generator function that does operations with channels via
// yield. This may seem a little cumbersome, but the pattern is (sort of) the
// same as in the second example with an ajax request via generators. (I called
// the function for `run` there, and not `go` as it's named here).
//
//
// Putting a value (1) into the channel.
go(function* () {
    yield put(ch, 1);
});

// The above is very contrived. Normally, we'd just do:
// putAsync(ch, 1);
// Without the generator or go function.

// Retrieving the value. The order does not matter here. We can put it after we
// take it out. That's the whole point.
go(function* () {
    var value = yield take(ch);

    console.log('I got:', value);   // 'I got: 1'
});

// We can even delay it.
go(function* () {
    yield take(timeout(500));       // pause here for 500 ms
    yield put(ch, 2);
});

// And retrieving it...
go(function* () {
    // The yield here pauses the function until something is added to the
    // channel that it can log. In this case, it will have to wait 500 ms.
    console.log('This time I got', yield take(ch)); // 'This time I got 2'
});


